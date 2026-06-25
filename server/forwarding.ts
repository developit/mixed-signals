import {
  formatCallMessage,
  formatErrorMessage,
  formatNotificationMessage,
  formatResultMessage,
  parseWireMessage,
  parseWireParams,
  REFRESH_MODELS_METHOD,
  ROOT_NOTIFICATION_METHOD,
  SIGNAL_UPDATE_METHOD,
  type Transport,
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
    if (key === '@S' && (typeof v === 'number' || typeof v === 'string')) {
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
      out['@S'] = stripSignalPrefix(prefix, v);
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
 * Strip the prefix from a prefixed signal ID, preserving nested upstream IDs.
 */
export function stripSignalPrefix(prefix: string, id: string): SignalId {
  const stripped = id.slice(prefix.length + SEP.length);
  const numeric = Number(stripped);
  return Number.isInteger(numeric) && String(numeric) === stripped
    ? numeric
    : stripped;
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
  private transport: Transport;
  private host: UpstreamHost;
  private disposed = false;

  /** Rewritten root from upstream, ready for merging into downstream root. */
  root: any = undefined;
  /** Resolves when the upstream root has been received. */
  ready: Promise<void>;
  private _resolveReady!: () => void;

  /** Upstream call ID → downstream forwarding target or local request promise. */
  private pendingCalls = new Map<
    number,
    | {clientId: string; callId: number}
    | {
        clientId?: string;
        resolve: (value: any) => void;
        reject: (error: Error) => void;
      }
  >();
  private nextUpstreamCallId = 1;

  private clients = new Set<string>();
  private signalSubscriptions = new Map<SignalId, Set<string>>();

  constructor(prefix: string, transport: Transport, host: UpstreamHost) {
    this.prefix = prefix;
    this.transport = transport;
    this.host = host;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });

    transport.onMessage((data) => {
      this.handleUpstreamMessage(data.toString());
    });
  }

  setClient(clientId: string) {
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
        // Parse params: [signalId, value, mode?]
        const params = parseWireParams(parsed.payload);
        const [signalId, value, mode] = params;
        const subscribers = this.signalSubscriptions.get(signalId as SignalId);
        const recipients =
          subscribers && subscribers.size > 0 ? subscribers : this.clients;
        if (recipients.size === 0) return;

        const prefixedId = `${this.prefix}${SEP}${signalId}`;

        // Only rewrite value if it contains @S/@M markers
        const rewrittenValue = needsRewrite(parsed.payload)
          ? addPrefix(this.prefix, value)
          : value;

        const outParams = mode
          ? [prefixedId, rewrittenValue, mode]
          : [prefixedId, rewrittenValue];
        const message = formatNotificationMessage(
          SIGNAL_UPDATE_METHOD,
          outParams,
        );

        for (const clientId of recipients) {
          this.host.send(clientId, message);
        }
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

      if ('resolve' in pending) {
        pending.resolve(rewritten);
      } else {
        this.host.send(
          pending.clientId,
          formatResultMessage(pending.callId, rewritten),
        );
      }
      return;
    }

    if (parsed.type === 'error') {
      const pending = this.pendingCalls.get(parsed.id);
      if (!pending) return;
      this.pendingCalls.delete(parsed.id);

      const error = JSON.parse(parsed.payload);
      if ('reject' in pending) {
        pending.reject(new Error(error?.message ?? String(error)));
      } else {
        this.host.send(
          pending.clientId,
          formatErrorMessage(pending.callId, error),
        );
      }
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

  request(method: string, params: any[], clientId?: string): Promise<any> {
    if (this.disposed) return Promise.reject(new Error('Upstream disposed'));

    const upstreamCallId = this.nextUpstreamCallId++;
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(upstreamCallId, {clientId, resolve, reject});
      this.transport.send(formatCallMessage(upstreamCallId, method, params));
    });
  }

  refreshModels(markers: string[], clientId?: string): Promise<any[]> {
    return this.request(REFRESH_MODELS_METHOD, markers, clientId).then(
      (result) => (Array.isArray(result) ? result : []),
    );
  }

  /**
   * Forward watch requests to the upstream.
   */
  forwardWatch(clientId: string, signalIds: SignalId[]) {
    const toWatch: SignalId[] = [];

    for (const signalId of new Set(signalIds)) {
      let subscribers = this.signalSubscriptions.get(signalId);
      const wasUnwatched = !subscribers || subscribers.size === 0;
      if (!subscribers) {
        subscribers = new Set();
        this.signalSubscriptions.set(signalId, subscribers);
      }

      subscribers.add(clientId);
      if (wasUnwatched) toWatch.push(signalId);
    }

    if (toWatch.length > 0) {
      this.transport.send(
        formatNotificationMessage(WATCH_SIGNALS_METHOD, toWatch),
      );
    }
  }

  /**
   * Forward unwatch requests to the upstream.
   */
  forwardUnwatch(clientId: string, signalIds: SignalId[]) {
    const toUnwatch: SignalId[] = [];

    for (const signalId of new Set(signalIds)) {
      const subscribers = this.signalSubscriptions.get(signalId);
      if (!subscribers || !subscribers.delete(clientId)) continue;

      if (subscribers.size === 0) {
        this.signalSubscriptions.delete(signalId);
        toUnwatch.push(signalId);
      }
    }

    if (toUnwatch.length > 0) {
      this.transport.send(
        formatNotificationMessage(UNWATCH_SIGNALS_METHOD, toUnwatch),
      );
    }
  }

  private clearPendingCalls(error: Error) {
    for (const pending of this.pendingCalls.values()) {
      if ('reject' in pending) {
        pending.reject(error);
      } else {
        this.host.send(
          pending.clientId,
          formatErrorMessage(pending.callId, {
            code: -1,
            message: error.message,
          }),
        );
      }
    }
    this.pendingCalls.clear();
  }

  private clearPendingCallsForClient(clientId: string) {
    const error = new Error('Downstream client disconnected');
    for (const [callId, pending] of this.pendingCalls) {
      if (pending.clientId !== clientId) continue;

      this.pendingCalls.delete(callId);
      if ('reject' in pending) pending.reject(error);
    }
  }

  /**
   * Clear the association with a downstream client (client disconnected).
   */
  removeClient(clientId: string) {
    this.clients.delete(clientId);
    this.clearPendingCallsForClient(clientId);

    const toUnwatch: SignalId[] = [];
    for (const [signalId, subscribers] of this.signalSubscriptions) {
      if (!subscribers.delete(clientId)) continue;

      if (subscribers.size === 0) {
        this.signalSubscriptions.delete(signalId);
        toUnwatch.push(signalId);
      }
    }

    if (toUnwatch.length > 0) {
      this.transport.send(
        formatNotificationMessage(UNWATCH_SIGNALS_METHOD, toUnwatch),
      );
    }
  }

  /**
   * Tear down this upstream connection entirely.
   */
  dispose() {
    this.disposed = true;
    this.clients.clear();
    this.signalSubscriptions.clear();
    this.clearPendingCalls(new Error('Upstream disposed'));
  }
}
