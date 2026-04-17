import {
  formatCallMessage,
  formatErrorMessage,
  formatNotificationMessage,
  formatResultMessage,
  HANDLE_MARKER,
  parseWireMessage,
  parseWireParams,
  RELEASE_HANDLES_METHOD,
  ROOT_NOTIFICATION_METHOD,
  SIGNAL_UPDATE_METHOD,
  type Transport,
  UNWATCH_SIGNALS_METHOD,
  WATCH_SIGNALS_METHOD,
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

function needsRewrite(rawPayload: string): boolean {
  return rawPayload.includes(`"${HANDLE_MARKER}"`);
}

interface UpstreamHost {
  send(clientId: string, message: string): void;
  /** Called when the upstream root changes. */
  onUpstreamRootChanged(): void;
}

/**
 * One upstream connection. Rewrites ids on inbound messages (adds the prefix)
 * and strips them on outbound (client → upstream) messages.
 */
export class ForwardedUpstream {
  readonly prefix: string;
  private transport: Transport;
  private host: UpstreamHost;
  private disposed = false;

  root: any = undefined;
  ready: Promise<void>;
  private _resolveReady!: () => void;

  private pendingCalls = new Map<number, {clientId: string; callId: number}>();
  private nextUpstreamCallId = 1;
  private clientId: string | undefined;

  constructor(prefix: string, transport: Transport, host: UpstreamHost) {
    this.prefix = prefix;
    this.transport = transport;
    this.host = host;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    transport.onMessage((data) => this.handleUpstreamMessage(data.toString()));
  }

  setClient(clientId: string) {
    this.clientId = clientId;
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
        if (!this.clientId) return;
        const params = parseWireParams(parsed.payload);
        const [signalId, value, mode] = params as [HandleId, any, string?];
        const prefixedId = prefixId(this.prefix, signalId);
        const rewrittenValue = needsRewrite(parsed.payload)
          ? addPrefix(this.prefix, value)
          : value;
        const outParams = mode
          ? [prefixedId, rewrittenValue, mode]
          : [prefixedId, rewrittenValue];
        this.host.send(
          this.clientId,
          formatNotificationMessage(SIGNAL_UPDATE_METHOD, outParams),
        );
        return;
      }
    }

    if (parsed.type === 'result') {
      const pending = this.pendingCalls.get(parsed.id);
      if (!pending) return;
      this.pendingCalls.delete(parsed.id);
      const result = JSON.parse(parsed.payload);
      const rewritten = needsRewrite(parsed.payload)
        ? addPrefix(this.prefix, result)
        : result;
      this.host.send(
        pending.clientId,
        formatResultMessage(pending.callId, rewritten),
      );
      return;
    }

    if (parsed.type === 'error') {
      const pending = this.pendingCalls.get(parsed.id);
      if (!pending) return;
      this.pendingCalls.delete(parsed.id);
      this.host.send(
        pending.clientId,
        formatErrorMessage(pending.callId, JSON.parse(parsed.payload)),
      );
    }
  }

  forwardCall(
    clientId: string,
    downstreamCallId: number,
    method: string,
    rawPayload: string,
  ) {
    const upstreamCallId = this.nextUpstreamCallId++;
    this.pendingCalls.set(upstreamCallId, {clientId, callId: downstreamCallId});
    const params = parseWireParams(rawPayload);
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
    if (this.clientId === clientId) {
      this.clientId = undefined;
      this.pendingCalls.clear();
    }
  }

  dispose() {
    this.disposed = true;
    this.clientId = undefined;
    this.pendingCalls.clear();
  }
}
