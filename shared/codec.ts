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
 * string-vs-raw branching so RPC code stays mode-agnostic.
 *
 * For `StringTransport`: applies the current framing (`M1:method:payload`)
 * on outbound and `parseWireMessage` + reviver-backed JSON.parse on inbound.
 * For `RawTransport`: passes the `WireMessage` object through unchanged, and
 * walks the inbound tree to resolve `@H` markers (since there's no reviver
 * hook without JSON.parse).
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
        const msg = this.decodeRaw(data);
        if (msg) return cb(msg, ctx);
      });
      return;
    }
    (this.transport as StringTransport).onMessage((data) => {
      const msg = decodeStringWire(data.toString(), this.makeReviver());
      if (msg) return cb(msg);
    });
  }

  private decodeRaw(data: unknown): WireMessage | null {
    if (!data || typeof data !== 'object') return null;
    const wire = data as WireMessage;
    if (typeof (wire as any).type !== 'string') return null;
    // If no hydrator is configured, deliver the wire tree verbatim. Handy
    // for brokers / middleware that want to inspect or rewrite markers
    // (e.g. `addPrefix` in forwarding.ts) before passing upstream.
    if (!this.revive) return wire;
    if (wire.type === 'call' || wire.type === 'notification') {
      return {
        ...wire,
        params: hydrateTree(wire.params, this.revive) as unknown[],
      } as WireMessage;
    }
    // result / error
    return {
      ...wire,
      value: hydrateTree((wire as any).value, this.revive),
    } as WireMessage;
  }

  private makeReviver():
    | ((key: string, value: unknown) => unknown)
    | undefined {
    const revive = this.revive;
    if (!revive) return undefined;
    return (_key, value) => {
      if (value && typeof value === 'object' && HANDLE_MARKER in value) {
        return revive(value as Record<string, unknown>);
      }
      return value;
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
export function hydrateTree(tree: unknown, revive: ReviveMarker): unknown {
  if (tree === null || typeof tree !== 'object') return tree;
  if (HANDLE_MARKER in (tree as Record<string, unknown>)) {
    // Walk body fields first, bottom-up, so nested markers inside `d` / `v`
    // are hydrated before `revive` sees the outer marker. Mirrors the
    // bottom-up semantics JSON.parse with a reviver provides for free on
    // the string path. Scalar identity fields (@H, c, p) pass through
    // hydrateTree unchanged since they're not objects.
    const marker = tree as Record<string, unknown>;
    const walked: Record<string, unknown> = {};
    for (const k in marker) {
      walked[k] = hydrateTree(marker[k], revive);
    }
    return revive(walked);
  }
  if (Array.isArray(tree)) {
    const out = new Array(tree.length);
    for (let i = 0; i < tree.length; i++) out[i] = hydrateTree(tree[i], revive);
    return out;
  }
  // Only walk plain objects. Any other constructor (Date, ArrayBuffer,
  // Uint8Array, Map, Set, MessagePort, class instances emitted inline by a
  // custom toJSON, …) is passed through as-is. This matches structured
  // clone's own preservation rules for those types.
  const proto = Object.getPrototypeOf(tree);
  if (proto !== null && proto !== Object.prototype) return tree;
  const out: Record<string, unknown> = {};
  for (const k in tree as Record<string, unknown>) {
    out[k] = hydrateTree((tree as Record<string, unknown>)[k], revive);
  }
  return out;
}

/**
 * Walk an outbound value, substituting branded (round-trip) handles with
 * their `@H` markers. Optionally populates `ctx.transfer` with detected
 * Transferable values (ArrayBuffer / MessagePort / ImageBitmap / etc.),
 * which flow through to `postMessage(msg, ctx)` on the raw path.
 *
 * Functions without a brand are dropped (matches the previous behavior of
 * `JSON.stringify` with functions: omitted from objects, `null` in arrays).
 * A branded function (callable proxy the client received from the server)
 * round-trips as `{@H: id}` like any other remote handle.
 */
export function substituteBrandsAndCollectTransferables(
  value: unknown,
  ctx?: TransportContext,
): unknown {
  return walkOutbound(value, ctx, false);
}

function walkOutbound(
  value: unknown,
  ctx: TransportContext | undefined,
  inArray: boolean,
): unknown {
  if (value === null || value === undefined) return inArray ? null : value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
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
      out[i] = walkOutbound(value[i], ctx, true);
    }
    return out;
  }
  // Honor `toJSON` (Date, custom opt-outs) — matches JSON.stringify semantics.
  const toJSON = (value as {toJSON?: () => unknown}).toJSON;
  if (typeof toJSON === 'function') {
    return walkOutbound(toJSON.call(value), ctx, inArray);
  }
  // Only walk plain objects. Class instances, typed arrays, Map/Set, etc.
  // pass through opaquely — on the raw path structured clone preserves
  // them, on the string path JSON.stringify handles them (lossy as it may
  // be; the caller opted into string mode).
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value)) {
    const v = walkOutbound((value as Record<string, unknown>)[k], ctx, false);
    if (v !== undefined) out[k] = v;
  }
  return out;
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
