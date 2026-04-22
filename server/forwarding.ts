import {
  formatCallMessage,
  formatNotificationMessage,
  HANDLE_MARKER,
  parseWireMessage,
  parseWireParams,
  RELEASE_HANDLES_METHOD,
  ROOT_NOTIFICATION_METHOD,
  SIGNAL_UPDATE_METHOD,
  type StringTransport,
  type Transport,
  UNWATCH_SIGNALS_METHOD,
  WATCH_SIGNALS_METHOD,
  type WireMessage,
} from '../shared/protocol.ts';

type HandleId = string;

const SEP = '_';

/**
 * Handle ids have the shape `<kind>[body]` — e.g. `s42`, `o17`, `f7`. When a
 * broker forwards a handle from an upstream to a downstream client, we want
 * to preserve the kind character (because clients branch on `id[0]`) while
 * tagging the id with an upstream prefix so the broker can later route calls
 * back to the right upstream.
 *
 *   upstream "1" + id "s42" → "s1_42"
 *   upstream "1" + id "o17" → "o1_17"
 *
 * This scheme is reversible by `stripPrefix` and compatible with the existing
 * wire format (still a plain string id).
 */
function prefixId(prefix: string, id: HandleId): HandleId {
  return `${id[0]}${prefix}${SEP}${id.slice(1)}`;
}

function stripIdPrefix(prefix: string, id: HandleId): HandleId | undefined {
  const p = `${prefix}${SEP}`;
  if (id.length < 2 || id.slice(1, 1 + p.length) !== p) return undefined;
  return `${id[0]}${id.slice(1 + p.length)}`;
}

/** Recursively add an upstream prefix to every @H id in a parsed JSON value. */
export function addPrefix(prefix: string, value: any): any {
  if (value === null || value === undefined || typeof value !== 'object')
    return value;
  if (Array.isArray(value)) return value.map((v) => addPrefix(prefix, v));
  const out: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (key === HANDLE_MARKER && typeof v === 'string') {
      out[HANDLE_MARKER] = prefixId(prefix, v);
    } else {
      out[key] = addPrefix(prefix, v);
    }
  }
  return out;
}

/** Recursively strip an upstream prefix from every @H id in a parsed JSON value. */
export function stripPrefix(prefix: string, value: any): any {
  if (value === null || value === undefined || typeof value !== 'object')
    return value;
  if (Array.isArray(value)) return value.map((v) => stripPrefix(prefix, v));
  const out: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (key === HANDLE_MARKER && typeof v === 'string') {
      const stripped = stripIdPrefix(prefix, v);
      out[HANDLE_MARKER] = stripped ?? v;
    } else {
      out[key] = stripPrefix(prefix, v);
    }
  }
  return out;
}

/** Check whether an id was produced by `prefixId` for the given prefix. */
export function isUpstreamId(prefix: string, id: HandleId): boolean {
  if (typeof id !== 'string' || id.length < 2) return false;
  const p = `${prefix}${SEP}`;
  return id.slice(1, 1 + p.length) === p;
}

/** Strip the prefix from a handle id (synonyms kept for API compat). */
export function stripSignalPrefix(prefix: string, id: HandleId): HandleId {
  return stripIdPrefix(prefix, id) ?? id;
}
export function stripInstancePrefix(prefix: string, id: HandleId): HandleId {
  return stripIdPrefix(prefix, id) ?? id;
}

function containsMarker(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsMarker);
  for (const key of Object.keys(value)) {
    if (key === HANDLE_MARKER) return true;
    if (containsMarker((value as Record<string, unknown>)[key])) return true;
  }
  return false;
}

interface UpstreamHost {
  /** Inject an already-framed wire message toward a specific downstream. */
  sendWire(clientId: string, msg: WireMessage): void;
  /** Called when the upstream root changes. */
  onUpstreamRootChanged(): void;
}

/**
 * One upstream connection. Rewrites ids on inbound messages (adds the prefix)
 * and strips them on outbound (client → upstream) messages.
 *
 * Upstreams speak the string-framed protocol. Raw-mode downstream clients
 * still work because `sendWire` hands already-structured `WireMessage`s to
 * the host, which dispatches through each client's codec.
 */
export class ForwardedUpstream {
  readonly prefix: string;
  private transport: StringTransport;
  private host: UpstreamHost;
  private disposed = false;

  root: any = undefined;
  ready: Promise<void>;
  private _resolveReady!: () => void;

  private pendingCalls = new Map<number, {clientId: string; callId: number}>();
  private nextUpstreamCallId = 1;
  /**
   * Every downstream client that should receive upstream push notifications
   * (signal updates today; potentially more in future). A broker may have N
   * downstream clients; all of them need the same upstream @S frame when
   * the upstream fires.
   */
  private clients = new Set<string>();

  constructor(prefix: string, transport: Transport, host: UpstreamHost) {
    if (transport.mode === 'raw') {
      throw new Error(
        'addUpstream: raw-mode transports are not supported for upstreams. Use a string-mode transport.',
      );
    }
    this.prefix = prefix;
    this.transport = transport as StringTransport;
    this.host = host;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.transport.onMessage((data) =>
      this.handleUpstreamMessage(data.toString()),
    );
  }

  addClient(clientId: string) {
    this.clients.add(clientId);
  }

  private handleUpstreamMessage(msg: string) {
    if (this.disposed) return;
    const parsed = parseWireMessage(msg);
    if (!parsed) return;

    if (parsed.type === 'notification') {
      if (parsed.method === ROOT_NOTIFICATION_METHOD) {
        const [rootValue] = parseWireParams(parsed.payload);
        this.root = addPrefix(this.prefix, rootValue);
        this._resolveReady();
        this.host.onUpstreamRootChanged();
        return;
      }
      if (parsed.method === SIGNAL_UPDATE_METHOD) {
        if (this.clients.size === 0) return;
        const params = parseWireParams(parsed.payload);
        const [signalId, value, mode] = params as [HandleId, any, string?];
        const prefixedId = prefixId(this.prefix, signalId);
        const rewrittenValue = containsMarker(value)
          ? addPrefix(this.prefix, value)
          : value;
        const outParams = mode
          ? [prefixedId, rewrittenValue, mode]
          : [prefixedId, rewrittenValue];
        // Fan the upstream push out to every downstream client. Broker
        // topology: N clients share one upstream; all must see the push.
        const msg = {
          type: 'notification' as const,
          method: SIGNAL_UPDATE_METHOD,
          params: outParams,
        };
        for (const clientId of this.clients) {
          this.host.sendWire(clientId, msg);
        }
        return;
      }
    }

    if (parsed.type === 'result') {
      const pending = this.pendingCalls.get(parsed.id);
      if (!pending) return;
      this.pendingCalls.delete(parsed.id);
      const result = JSON.parse(parsed.payload);
      const rewritten = containsMarker(result)
        ? addPrefix(this.prefix, result)
        : result;
      this.host.sendWire(pending.clientId, {
        type: 'result',
        id: pending.callId,
        value: rewritten,
      });
      return;
    }

    if (parsed.type === 'error') {
      const pending = this.pendingCalls.get(parsed.id);
      if (!pending) return;
      this.pendingCalls.delete(parsed.id);
      this.host.sendWire(pending.clientId, {
        type: 'error',
        id: pending.callId,
        value: JSON.parse(parsed.payload),
      });
    }
  }

  forwardCall(
    clientId: string,
    downstreamCallId: number,
    method: string,
    params: unknown[],
  ) {
    const upstreamCallId = this.nextUpstreamCallId++;
    this.pendingCalls.set(upstreamCallId, {clientId, callId: downstreamCallId});
    this.transport.send(formatCallMessage(upstreamCallId, method, params));
  }

  forwardWatch(signalIds: HandleId[]) {
    this.transport.send(
      formatNotificationMessage(WATCH_SIGNALS_METHOD, signalIds),
    );
  }

  forwardUnwatch(signalIds: HandleId[]) {
    this.transport.send(
      formatNotificationMessage(UNWATCH_SIGNALS_METHOD, signalIds),
    );
  }

  forwardRelease(handleIds: HandleId[]) {
    this.transport.send(
      formatNotificationMessage(RELEASE_HANDLES_METHOD, handleIds),
    );
  }

  removeClient(clientId: string) {
    this.clients.delete(clientId);
    // Cancel pending calls originated by this client. Keep calls from
    // other clients intact.
    for (const [upId, pending] of this.pendingCalls) {
      if (pending.clientId === clientId) this.pendingCalls.delete(upId);
    }
  }

  dispose() {
    this.disposed = true;
    this.clients.clear();
    this.pendingCalls.clear();
  }
}
