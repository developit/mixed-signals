import {BRAND_REMOTE, type RemoteBrand} from './brand.ts';
import {
  formatCallMessage,
  formatErrorMessage,
  formatNotificationMessage,
  formatResultMessage,
  HANDLE_MARKER,
  parseWireMessage,
  parseWireParams,
  parseWireValue,
  type RawTransport,
  type StringTransport,
  type Transport,
  type TransportContext,
  type WireMessage,
} from './protocol.ts';

/**
 * Resolve a wire `@H` marker to a live peer-side value.
 *   - Client: builds (or looks up) a Proxy / Signal / callable / Promise.
 *   - Server: resolves the id back to the live registered value.
 *
 * Called once per `@H`-bearing object during inbound tree walk. The resolver
 * is responsible for recursing into marker bodies (class slots, etc.) — the
 * codec only finds top-level markers.
 */
export type ReviveMarker = (marker: Record<string, unknown>) => unknown;

/**
 * Wraps a `Transport` and speaks `WireMessage` on both sides. Hides all
 * string-vs-raw branching so RPC code stays mode-agnostic, and plumbs the
 * transport's optional `encode` / `decode` per-node hooks into the outbound
 * serializer and inbound hydrator walks respectively.
 *
 * For `StringTransport`: applies the current framing (`M1:method:payload`)
 * on outbound and `parseWireMessage` on inbound. `decode` fires during the
 * reviver-backed JSON.parse walk (bottom-up, matches native semantics).
 * For `RawTransport`: passes the `WireMessage` object through unchanged.
 * `decode` fires during `hydrateTree` on the inbound object tree.
 */
export class PeerCodec {
  readonly mode: 'string' | 'raw';
  readonly ready: Promise<void> | undefined;
  private transport: Transport;
  private revive?: ReviveMarker;

  constructor(transport: Transport, revive?: ReviveMarker) {
    this.transport = transport;
    this.mode = transport.mode === 'raw' ? 'raw' : 'string';
    this.ready = transport.ready;
    this.revive = revive;
  }

  /** Expose the transport's outbound codec hook for the serializer. */
  get encode(): Transport['encode'] {
    return this.transport.encode;
  }

  /**
   * Swap out the resolver. Used on reconnect — the old hydrator is cleared
   * and a fresh one is wired up.
   */
  setRevive(revive: ReviveMarker | undefined): void {
    this.revive = revive;
  }

  send(msg: WireMessage, ctx?: TransportContext): void {
    if (this.mode === 'raw') {
      (this.transport as RawTransport).send(msg, ctx);
      return;
    }
    (this.transport as StringTransport).send(encodeWireMessage(msg));
  }

  onMessage(
    cb: (msg: WireMessage, ctx?: TransportContext) => void | Promise<void>,
  ): void {
    if (this.mode === 'raw') {
      (this.transport as RawTransport).onMessage((data, ctx) => {
        const msg = this.decodeRaw(data, ctx);
        if (msg) return cb(msg, ctx);
      });
      return;
    }
    (this.transport as StringTransport).onMessage((data) => {
      const msg = decodeStringWire(data.toString(), this.makeReviver());
      if (msg) return cb(msg);
    });
  }

  private decodeRaw(
    data: unknown,
    ctx: TransportContext | undefined,
  ): WireMessage | null {
    if (!data || typeof data !== 'object') return null;
    const wire = data as WireMessage;
    if (typeof (wire as any).type !== 'string') return null;
    const revive = this.revive;
    const decode = this.transport.decode;
    // If neither hydrator nor user-decode is configured, deliver the wire
    // tree verbatim. Handy for brokers / middleware that want to inspect
    // or rewrite markers (e.g. `addPrefix` in forwarding.ts) before
    // passing upstream.
    if (!revive && !decode) return wire;
    if (wire.type === 'call' || wire.type === 'notification') {
      return {
        ...wire,
        params: hydrateTree(wire.params, revive, decode, ctx) as unknown[],
      } as WireMessage;
    }
    // result / error
    return {
      ...wire,
      value: hydrateTree((wire as any).value, revive, decode, ctx),
    } as WireMessage;
  }

  private makeReviver():
    | ((key: string, value: unknown) => unknown)
    | undefined {
    const revive = this.revive;
    const decode = this.transport.decode;
    if (!revive && !decode) return undefined;
    return (_key, value) => {
      // Reviver runs bottom-up natively; user `decode` fires here at each
      // node (with already-decoded children), and `@H` resolution fires
      // after to resolve handles on top of whatever `decode` produced.
      let current: unknown = value;
      if (decode && current && typeof current === 'object') {
        const replaced = decode(current);
        if (replaced !== undefined) current = replaced;
      }
      if (
        revive &&
        current &&
        typeof current === 'object' &&
        HANDLE_MARKER in current
      ) {
        return revive(current as Record<string, unknown>);
      }
      return current;
    };
  }
}

/**
 * Walk a structurally-cloned tree, resolving any `@H` markers via `revive`.
 * Only plain objects (Object.prototype or null-proto) and arrays are walked;
 * anything else (ArrayBuffer, Map, Set, Date, typed arrays, Blob, class
 * instances the app sent inline, …) passes through untouched. Markers
 * themselves may contain nested markers in their body; the resolver is
 * expected to recurse into them (on the client, `hydrator.hydrate` already
 * does this via `reviveSlot`).
 */
export function hydrateTree(
  tree: unknown,
  revive: ReviveMarker | undefined,
  decode?: (value: unknown, ctx?: TransportContext) => unknown,
  ctx?: TransportContext,
): unknown {
  if (tree === null || typeof tree !== 'object') return tree;
  if (revive && HANDLE_MARKER in (tree as Record<string, unknown>)) {
    // Walk body fields first, bottom-up, so nested markers (including `@T`
    // codec tags) inside `d` / `v` are hydrated before `revive` sees the
    // outer marker. Mirrors the bottom-up semantics JSON.parse with a
    // reviver provides for free on the string path. Scalar identity fields
    // (@H, c, p) pass through unchanged since they're not objects.
    const marker = tree as Record<string, unknown>;
    const walked: Record<string, unknown> = {};
    for (const k in marker) {
      walked[k] = hydrateTree(marker[k], revive, decode, ctx);
    }
    return revive(walked);
  }
  if (Array.isArray(tree)) {
    const out = new Array(tree.length);
    for (let i = 0; i < tree.length; i++)
      out[i] = hydrateTree(tree[i], revive, decode, ctx);
    if (decode) {
      const replaced = decode(out, ctx);
      if (replaced !== undefined && replaced !== out) return replaced;
    }
    return out;
  }
  // Non-plain objects (Date, Map, Uint8Array, RegExp, class instances a raw
  // transport may have preserved via structured clone, …) still get one
  // shot at `decode` — a user's codec may want to transform e.g. an inbound
  // Date to a different in-app representation. Most don't, and return
  // `undefined` to pass through.
  const proto = Object.getPrototypeOf(tree);
  if (proto !== null && proto !== Object.prototype) {
    if (decode) {
      const replaced = decode(tree, ctx);
      if (replaced !== undefined && replaced !== tree) return replaced;
    }
    return tree;
  }
  const out: Record<string, unknown> = {};
  for (const k in tree as Record<string, unknown>) {
    out[k] = hydrateTree(
      (tree as Record<string, unknown>)[k],
      revive,
      decode,
      ctx,
    );
  }
  // Plain object, fully-walked children — now a codec gets a chance to
  // recognize a `@T` tag and rebuild a Map / Set / custom class. Runs
  // bottom-up so a `@T`-tagged object inside a `d` field is already rebuilt
  // by the time the enclosing `@H` marker sees it as a slot value.
  if (decode) {
    const replaced = decode(out, ctx);
    if (replaced !== undefined && replaced !== out) return replaced;
  }
  return out;
}

/**
 * Walk an outbound value, substituting branded (round-trip) handles with
 * their `@H` markers. Optionally populates `ctx.transfer` with detected
 * Transferable values (ArrayBuffer / MessagePort / ImageBitmap / etc.),
 * which flow through to `postMessage(msg, ctx)` on the raw path.
 *
 * If an `encode` transform is supplied (from the transport's codec hook),
 * it runs top-down at each node *before* the walker would otherwise try to
 * walk into the value — so Map / Set / typed arrays / custom classes get a
 * chance to be tagged with `@T` markers before descent. The walker recurses
 * into the replacement so nested signals / handles get `@H`-emitted.
 *
 * Functions without a brand are dropped (matches the previous behavior of
 * `JSON.stringify` with functions: omitted from objects, `null` in arrays).
 * A branded function (callable proxy the client received from the server)
 * round-trips as `{@H: id}` like any other remote handle.
 */
export function substituteBrandsAndCollectTransferables(
  value: unknown,
  ctx?: TransportContext,
  encode?: (value: unknown, ctx?: TransportContext) => unknown,
): unknown {
  return walkOutbound(value, ctx, false, encode);
}

function walkOutbound(
  value: unknown,
  ctx: TransportContext | undefined,
  inArray: boolean,
  encode: ((value: unknown, ctx?: TransportContext) => unknown) | undefined,
): unknown {
  if (value === null || value === undefined) return inArray ? null : value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') {
    // JSON has no native BigInt; give the encode hook a chance to tag.
    if (encode) {
      const replaced = encode(value, ctx);
      if (replaced !== undefined && replaced !== value) {
        return walkOutbound(replaced, ctx, inArray, encode);
      }
    }
    return value;
  }
  if (t === 'function') {
    const brand = (value as any)[BRAND_REMOTE] as RemoteBrand | undefined;
    if (brand) return {[HANDLE_MARKER]: brand.id};
    // Unbranded functions have no wire representation — drop.
    return inArray ? null : undefined;
  }
  if (t !== 'object') return value;
  const brand = (value as any)[BRAND_REMOTE] as RemoteBrand | undefined;
  if (brand) return {[HANDLE_MARKER]: brand.id};
  if (isTransferable(value)) {
    if (ctx) {
      if (!ctx.transfer) ctx.transfer = [];
      ctx.transfer.push(value as Transferable);
    }
    return value;
  }
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = walkOutbound(value[i], ctx, true, encode);
    }
    return out;
  }
  // Transport-level codec hook: tag rich types (Map/Set/typed array/custom)
  // before we'd otherwise pass them through as opaque. Walker recurses into
  // the replacement so handles inside a `@T` body emit `@H` correctly.
  if (encode) {
    const replaced = encode(value, ctx);
    if (replaced !== undefined && replaced !== value) {
      return walkOutbound(replaced, ctx, inArray, encode);
    }
  }
  // Honor `toJSON` (Date, custom opt-outs) — matches JSON.stringify semantics.
  const toJSON = (value as {toJSON?: () => unknown}).toJSON;
  if (typeof toJSON === 'function') {
    return walkOutbound(toJSON.call(value), ctx, inArray, encode);
  }
  // Only walk plain objects. Class instances, typed arrays, Map/Set, etc.
  // pass through opaquely — on the raw path structured clone preserves
  // them, on the string path JSON.stringify handles them (lossy as it may
  // be; the caller opted into string mode).
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value)) {
    const v = walkOutbound(
      (value as Record<string, unknown>)[k],
      ctx,
      false,
      encode,
    );
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Built-in constructors that should pass through the serializer opaquely,
 * rather than being mis-identified as "classes with methods" (which would
 * upgrade them to `@H` handles because their prototypes carry methods).
 *
 * On the raw path, structured clone preserves all of these natively. On the
 * string path, they reach `transport.encode` intact so a codec can tag them
 * as `@T` markers before the library's `JSON.stringify` step runs.
 */
export function isWireOpaque(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (ArrayBuffer.isView(value)) return true;
  if (value instanceof Map) return true;
  if (value instanceof Set) return true;
  if (value instanceof RegExp) return true;
  if (value instanceof Error) return true;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  if (typeof File !== 'undefined' && value instanceof File) return true;
  if (typeof URL !== 'undefined' && value instanceof URL) return true;
  if (
    typeof URLSearchParams !== 'undefined' &&
    value instanceof URLSearchParams
  )
    return true;
  return false;
}

/**
 * Transferable detection. We check via `instanceof` with feature-guards so
 * this works in Node, Workers, and browsers without pulling in polyfills.
 *
 * The list mirrors the DOM spec's Transferable interface set:
 * https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
 */
export function isTransferable(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer)
    return true;
  if (typeof MessagePort !== 'undefined' && value instanceof MessagePort)
    return true;
  if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap)
    return true;
  if (
    typeof OffscreenCanvas !== 'undefined' &&
    value instanceof OffscreenCanvas
  )
    return true;
  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream)
    return true;
  if (typeof WritableStream !== 'undefined' && value instanceof WritableStream)
    return true;
  if (
    typeof TransformStream !== 'undefined' &&
    value instanceof TransformStream
  )
    return true;
  return false;
}

function encodeWireMessage(msg: WireMessage): string {
  switch (msg.type) {
    case 'call':
      return formatCallMessage(msg.id, msg.method, msg.params);
    case 'notification':
      return formatNotificationMessage(msg.method, msg.params);
    case 'result':
      return formatResultMessage(msg.id, msg.value);
    case 'error':
      return formatErrorMessage(msg.id, msg.value);
  }
}

function decodeStringWire(
  raw: string,
  reviver: ((key: string, value: unknown) => unknown) | undefined,
): WireMessage | null {
  const parsed = parseWireMessage(raw);
  if (!parsed) return null;
  switch (parsed.type) {
    case 'call':
      return {
        type: 'call',
        id: parsed.id,
        method: parsed.method,
        params: parseWireParams(parsed.payload, reviver),
      };
    case 'notification':
      return {
        type: 'notification',
        method: parsed.method,
        params: parseWireParams(parsed.payload, reviver),
      };
    case 'result':
      return {
        type: 'result',
        id: parsed.id,
        value: parseWireValue(parsed.payload, reviver),
      };
    case 'error':
      return {
        type: 'error',
        id: parsed.id,
        value: parseWireValue(parsed.payload, reviver),
      };
  }
}
