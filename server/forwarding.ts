import {
  formatCallMessage,
  formatErrorMessage,
  formatNotificationMessage,
  formatResultMessage,
  parseWireMessage,
  parseWireParams,
  ROOT_NOTIFICATION_METHOD,
  SIGNAL_UPDATE_METHOD,
  type StringTransport,
  UNWATCH_SIGNALS_METHOD,
  WATCH_SIGNALS_METHOD,
} from '../shared/protocol.ts';

type SignalId = number | string;

const SEP = '_';

/**
 * Recursively adds an upstream prefix to all @S and @M markers in a parsed JSON value.
 * Uses "_" as the separator to avoid colliding with the wire format's ":" field separator.
 */
export function addPrefix(prefix: string, value: any): any {
  if (value === null || value === undefined || typeof value !== 'object')
    return value;
  if (Array.isArray(value)) return value.map((v) => addPrefix(prefix, v));

  const out: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (key === '@S' && typeof v === 'number') {
      out['@S'] = `${prefix}${SEP}${v}`;
    } else if (key === '@M' && typeof v === 'string') {
      const h = v.lastIndexOf('#');
      out['@M'] =
        h === -1 ? v : `${v.slice(0, h + 1)}${prefix}${SEP}${v.slice(h + 1)}`;
    } else {
      out[key] = addPrefix(prefix, v);
    }
  }
  return out;
}

/**
 * Recursively strips an upstream prefix from all @S and @M markers in a parsed JSON value.
 */
export function stripPrefix(prefix: string, value: any): any {
  if (value === null || value === undefined || typeof value !== 'object')
    return value;
  if (Array.isArray(value)) return value.map((v) => stripPrefix(prefix, v));

  const pfx = `${prefix}${SEP}`;
  const out: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (key === '@S' && typeof v === 'string' && v.startsWith(pfx)) {
      out['@S'] = Number(v.slice(pfx.length));
    } else if (key === '@M' && typeof v === 'string') {
      const h = v.lastIndexOf('#');
      if (h !== -1 && v.slice(h + 1).startsWith(pfx)) {
        out['@M'] = `${v.slice(0, h + 1)}${v.slice(h + 1 + pfx.length)}`;
      } else {
        out['@M'] = v;
      }
    } else {
      out[key] = stripPrefix(prefix, v);
    }
  }
  return out;
}

/**
 * Check if a signal ID or instance ID belongs to an upstream with the given prefix.
 */
export function isUpstreamId(prefix: string, id: SignalId): boolean {
  return typeof id === 'string' && id.startsWith(`${prefix}${SEP}`);
}

/**
 * Strip the prefix from a prefixed signal ID, returning the original numeric ID.
 */
export function stripSignalPrefix(prefix: string, id: string): number {
  return Number(id.slice(prefix.length + SEP.length));
}

/**
 * Strip the prefix from a prefixed instance ID, returning the original ID.
 */
export function stripInstancePrefix(prefix: string, id: string): string {
  return id.slice(prefix.length + SEP.length);
}

/**
 * Quick check: does the raw payload string contain any @S or @M markers
 * that would require JSON rewriting? Avoids parsing for simple streaming deltas.
 */
function needsRewrite(rawPayload: string): boolean {
  return rawPayload.includes('"@S"') || rawPayload.includes('"@M"');
}

interface UpstreamHost {
  send(clientId: string, message: string): void;
  /** Called when the upstream root changes. Host should re-merge and broadcast. */
  onUpstreamRootChanged(): void;
}

/**
 * Manages a single upstream connection. Intercepts wire messages from the
 * upstream and rewrites IDs before forwarding to downstream clients.
 */
export class ForwardedUpstream {
  readonly prefix: string;
  private transport: StringTransport;
  private host: UpstreamHost;
  private disposed = false;

  /** Rewritten root from upstream, ready for merging into downstream root. */
  root: any = undefined;
  /** Resolves when the upstream root has been received. */
  ready: Promise<void>;
  private _resolveReady!: () => void;

  /** Upstream call ID → { clientId, downstreamCallId } */
  private pendingCalls = new Map<number, {clientId: string; callId: number}>();
  private nextUpstreamCallId = 1;

  /** The single downstream client ID using this upstream (1:1 per-browser mapping). */
  private clientId: string | undefined;

  constructor(prefix: string, transport: StringTransport, host: UpstreamHost) {
    this.prefix = prefix;
    this.transport = transport;
    this.host = host;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });

    transport.onMessage((data) => {
      this.handleUpstreamMessage(data);
    });
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

        // Parse params: [signalId, value, mode?]
        const params = parseWireParams(parsed.payload);
        const [signalId, value, mode] = params;
        const prefixedId = `${this.prefix}${SEP}${signalId}`;

        // Only rewrite value if it contains @S/@M markers
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

  /**
   * Forward a method call from a downstream client to the upstream.
   */
  forwardCall(
    clientId: string,
    downstreamCallId: number,
    method: string,
    rawPayload: string,
  ) {
    const upstreamCallId = this.nextUpstreamCallId++;
    this.pendingCalls.set(upstreamCallId, {clientId, callId: downstreamCallId});

    // TODO: strip prefix from params when methods accept model/signal references as arguments
    const params = parseWireParams(rawPayload);
    this.transport.send(formatCallMessage(upstreamCallId, method, params));
  }

  /**
   * Forward watch requests to the upstream.
   */
  forwardWatch(signalIds: number[]) {
    this.transport.send(
      formatNotificationMessage(WATCH_SIGNALS_METHOD, signalIds),
    );
  }

  /**
   * Forward unwatch requests to the upstream.
   */
  forwardUnwatch(signalIds: number[]) {
    this.transport.send(
      formatNotificationMessage(UNWATCH_SIGNALS_METHOD, signalIds),
    );
  }

  /**
   * Clear the association with a downstream client (client disconnected).
   */
  removeClient(clientId: string) {
    if (this.clientId === clientId) {
      this.clientId = undefined;
      this.pendingCalls.clear();
    }
  }

  /**
   * Tear down this upstream connection entirely.
   */
  dispose() {
    this.disposed = true;
    this.clientId = undefined;
    this.pendingCalls.clear();
  }
}
