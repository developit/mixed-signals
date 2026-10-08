import {
  DROP_REFERENCES_METHOD,
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
      out['@S'] = prefixSignalId(prefix, v);
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
    if (
      key === '@S' &&
      typeof v === 'string' &&
      (v.startsWith(pfx) || v.slice(v.lastIndexOf('#') + 1).startsWith(pfx))
    ) {
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
  const hash = id.lastIndexOf('#');
  if (hash !== -1) {
    return `${id.slice(0, hash + 1)}${stripInstancePrefix(prefix, id.slice(hash + 1))}`;
  }
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

function prefixSignalId(prefix: string, id: SignalId): string {
  if (typeof id === 'string' && id.includes('#')) {
    const hash = id.lastIndexOf('#');
    return `${id.slice(0, hash + 1)}${prefix}${SEP}${id.slice(hash + 1)}`;
  }
  return `${prefix}${SEP}${id}`;
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
  private clientGenerations = new Map<string, number>();
  private updateVersions = new Map<string, Map<SignalId, number>>();
  private pendingUpdates = new Map<string, Set<SignalId>>();
  private signalSubscriptions = new Map<SignalId, Set<string>>();
  private modelVisibility = new Map<string, Set<string>>();
  private signalVisibility = new Map<SignalId, Set<string>>();
  private latestSignalValues = new Map<SignalId, any>();
  private finalSignalIds = new Set<SignalId>();

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
    this.clientGenerations.set(
      clientId,
      (this.clientGenerations.get(clientId) ?? 0) + 1,
    );
    this.clients.add(clientId);
    this.rememberVisibleModels(clientId, this.root);
    this.rememberVisibleSignals(clientId, this.root);
  }

  private handleUpstreamMessage(msg: string) {
    if (this.disposed) return;

    const parsed = parseWireMessage(msg);
    if (!parsed) return;

    if (parsed.type === 'notification') {
      if (parsed.method === ROOT_NOTIFICATION_METHOD) {
        const [rootValue] = parseWireParams(parsed.payload);
        this.rememberSignalSnapshots(rootValue);
        this.root = addPrefix(this.prefix, rootValue);
        for (const clientId of this.clients) {
          this.rememberVisibleModels(clientId, this.root);
          this.rememberVisibleSignals(clientId, this.root);
        }
        this._resolveReady();
        this.host.onUpstreamRootChanged();
        return;
      }

      if (parsed.method === SIGNAL_UPDATE_METHOD) {
        // Parse params: [signalId, value, mode?]
        const params = parseWireParams<[SignalId, any, string?]>(
          parsed.payload,
        );
        const [signalId, value, mode] = params;
        if (mode === 'seal') {
          this.forwardFinalSignal(signalId as SignalId);
          return;
        }

        const current = this.latestSignalValues.get(signalId as SignalId);
        this.latestSignalValues.set(
          signalId as SignalId,
          mode === 'append'
            ? Array.isArray(current)
              ? [...current, ...value]
              : typeof current === 'string'
                ? current + value
                : value
            : mode === 'merge' && current && typeof current === 'object'
              ? {...current, ...value}
              : value,
        );
        this.rememberSignalSnapshots(value);
        const recipients = this.signalSubscriptions.get(signalId as SignalId);
        if (!recipients || recipients.size === 0) return;

        const prefixedId = prefixSignalId(this.prefix, signalId as SignalId);

        // Only rewrite value if it contains @S/@M markers
        const rewrittenValue = needsRewrite(parsed.payload)
          ? addPrefix(this.prefix, value)
          : value;

        for (const clientId of recipients) {
          this.sendPreparedUpdate(
            clientId,
            signalId,
            prefixedId,
            rewrittenValue,
            mode,
          );
        }
        return;
      }

      if (parsed.method === DROP_REFERENCES_METHOD) {
        const markers = parseWireParams<string[]>(parsed.payload);
        for (const marker of markers) {
          const prefixed = addPrefix(this.prefix, {'@M': marker})['@M'];
          const recipients = new Set(this.modelVisibility.get(prefixed) ?? []);
          for (const [id, subscribers] of this.signalSubscriptions) {
            if (typeof id === 'string' && id.startsWith(`${marker}.`)) {
              for (const clientId of subscribers) recipients.add(clientId);
              this.signalSubscriptions.delete(id);
            }
          }
          this.modelVisibility.delete(prefixed);
          for (const id of this.signalVisibility.keys()) {
            if (typeof id === 'string' && id.startsWith(`${prefixed}.`))
              this.signalVisibility.delete(id);
          }
          for (const id of this.latestSignalValues.keys()) {
            if (typeof id === 'string' && id.startsWith(`${marker}.`))
              this.latestSignalValues.delete(id);
          }
          for (const clientId of recipients) {
            this.host.send(
              clientId,
              formatNotificationMessage(DROP_REFERENCES_METHOD, [prefixed]),
            );
          }
        }
        return;
      }
    }

    if (parsed.type === 'result') {
      const pending = this.pendingCalls.get(parsed.id);
      if (!pending) return;
      this.pendingCalls.delete(parsed.id);

      const result = JSON.parse(parsed.payload);
      this.rememberSignalSnapshots(result);
      const rewritten = needsRewrite(parsed.payload)
        ? addPrefix(this.prefix, result)
        : result;

      if ('resolve' in pending) {
        if (pending.clientId) {
          this.rememberVisibleModels(pending.clientId, rewritten);
          this.rememberVisibleSignals(pending.clientId, rewritten);
        }
        pending.resolve(rewritten);
      } else {
        const send = (prepared: any) => {
          if (!this.clients.has(pending.clientId)) return;
          this.rememberVisibleModels(pending.clientId, prepared);
          this.rememberVisibleSignals(pending.clientId, prepared);
          this.host.send(
            pending.clientId,
            formatResultMessage(pending.callId, prepared),
          );
        };
        const prepared = this.prepareForClient(rewritten, pending.clientId);
        if (prepared instanceof Promise) {
          void prepared.then(send, (error: Error) =>
            this.host.send(
              pending.clientId,
              formatErrorMessage(pending.callId, {
                code: -1,
                message: error.message,
              }),
            ),
          );
        } else send(prepared);
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

  private sendPreparedUpdate(
    clientId: string,
    signalId: SignalId,
    prefixedId: string,
    value: any,
    mode?: string,
    cached = false,
  ) {
    let versions = this.updateVersions.get(clientId);
    if (!versions) this.updateVersions.set(clientId, (versions = new Map()));
    const version = (versions.get(signalId) ?? 0) + 1;
    versions.set(signalId, version);
    const generation = this.clientGenerations.get(clientId);
    const pending = this.pendingUpdates.get(clientId)?.has(signalId);
    if (pending) {
      // A preceding update is waiting on a model refresh. A later delta needs
      // its complete current value if the earlier frame is superseded.
      value = addPrefix(this.prefix, this.latestSignalValues.get(signalId));
      mode = undefined;
      cached = true;
    }
    const send = (prepared: any) => {
      if (
        this.clientGenerations.get(clientId) !== generation ||
        versions.get(signalId) !== version
      )
        return;
      this.pendingUpdates.get(clientId)?.delete(signalId);
      this.rememberVisibleModels(clientId, prepared);
      this.rememberVisibleSignals(clientId, prepared);
      this.host.send(
        clientId,
        formatNotificationMessage(
          SIGNAL_UPDATE_METHOD,
          mode ? [prefixedId, prepared, mode] : [prefixedId, prepared],
        ),
      );
    };
    const prepared = this.prepareForClient(
      value,
      clientId,
      cached,
      new Set(),
      generation,
    );
    if (prepared instanceof Promise) {
      let ids = this.pendingUpdates.get(clientId);
      if (!ids) this.pendingUpdates.set(clientId, (ids = new Set()));
      ids.add(signalId);
      void prepared.then(send);
    } else send(prepared);
  }

  private forwardFinalSignal(signalId: SignalId) {
    this.finalSignalIds.add(signalId);
    this.latestSignalValues.delete(signalId);
    const subscribers = this.signalSubscriptions.get(signalId);
    const recipients = subscribers;
    this.signalSubscriptions.delete(signalId);
    if (!recipients) return;

    const message = formatNotificationMessage(SIGNAL_UPDATE_METHOD, [
      prefixSignalId(this.prefix, signalId),
      null,
      'seal',
    ]);
    for (const clientId of recipients) this.host.send(clientId, message);
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

  private rememberSignalSnapshots(value: any) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) this.rememberSignalSnapshots(item);
      return;
    }
    if (Object.hasOwn(value, '@S') && Object.hasOwn(value, 'v')) {
      this.latestSignalValues.set(value['@S'], value.v);
    }
    if (typeof value['@M'] === 'string') {
      const metadata = value['@P'];
      const plainValueProperties = new Set<string>(
        Array.isArray(metadata) ? metadata : (metadata?.keys ?? []),
      );
      for (const [key, rawField] of Object.entries(value)) {
        const field =
          key === '@P' && !Array.isArray(metadata) ? metadata?.value : rawField;
        if (
          key !== '@M' &&
          !plainValueProperties.has(key) &&
          field &&
          typeof field === 'object' &&
          Object.hasOwn(field, 'v') &&
          !Object.hasOwn(field, '@S')
        ) {
          this.latestSignalValues.set(
            `${value['@M']}.${key}`,
            (field as {v: any}).v,
          );
        }
      }
    }
    for (const nested of Object.values(value))
      this.rememberSignalSnapshots(nested);
  }

  private rememberVisibleSignals(clientId: string, value: any) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) this.rememberVisibleSignals(clientId, item);
      return;
    }
    if (Object.hasOwn(value, '@S')) {
      const id = value['@S'] as SignalId;
      let clients = this.signalVisibility.get(id);
      if (!clients) this.signalVisibility.set(id, (clients = new Set()));
      clients.add(clientId);
    }
    if (typeof value['@M'] === 'string') {
      const metadata = value['@P'];
      const plain = new Set(
        Array.isArray(metadata) ? metadata : (metadata?.keys ?? []),
      );
      for (const [key, rawField] of Object.entries(value)) {
        const field =
          key === '@P' && !Array.isArray(metadata) ? metadata?.value : rawField;
        if (
          key === '@M' ||
          plain.has(key) ||
          !field ||
          typeof field !== 'object' ||
          !Object.hasOwn(field, 'v') ||
          Object.hasOwn(field, '@S')
        )
          continue;
        const id = `${value['@M']}.${key}`;
        let clients = this.signalVisibility.get(id);
        if (!clients) this.signalVisibility.set(id, (clients = new Set()));
        clients.add(clientId);
      }
    }
    for (const nested of Object.values(value))
      this.rememberVisibleSignals(clientId, nested);
  }

  /** Resolve an upstream bare ref when this particular downstream client has forgotten it. */
  private prepareForClient(
    value: any,
    clientId: string,
    cached = false,
    seen = new Set<string>(),
    generation = this.clientGenerations.get(clientId),
  ): any | Promise<any> {
    if (this.clientGenerations.get(clientId) !== generation) return null;
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      const items = value.map((item) =>
        this.prepareForClient(item, clientId, cached, seen, generation),
      );
      return items.some((item) => item instanceof Promise)
        ? Promise.all(items)
        : items;
    }

    if (Object.hasOwn(value, '@S')) {
      const id = stripSignalPrefix(this.prefix, value['@S']);
      const missing =
        !Object.hasOwn(value, 'v') &&
        !this.signalVisibility.get(value['@S'])?.has(clientId);
      if ((missing || cached) && this.latestSignalValues.has(id)) {
        value = {
          ...value,
          v: addPrefix(this.prefix, this.latestSignalValues.get(id)),
        };
      } else if (missing) {
        throw new Error(`Signal snapshot unavailable: ${value['@S']}`);
      }
    }
    if (typeof value['@M'] === 'string') {
      const marker = value['@M'];
      if (!seen.has(marker)) {
        seen.add(marker);
        if (
          cached ||
          (Object.keys(value).length === 1 &&
            !this.modelVisibility.get(marker)?.has(clientId))
        ) {
          const upstreamMarker = stripPrefix(this.prefix, {'@M': marker})['@M'];
          return this.refreshModels([upstreamMarker]).then(([fresh]) =>
            fresh
              ? this.prepareForClient(fresh, clientId, false, seen, generation)
              : null,
          );
        }
      }
    }
    const entries = Object.entries(value).map(
      ([key, item]) =>
        [
          key,
          this.prepareForClient(item, clientId, cached, seen, generation),
        ] as const,
    );
    if (entries.some(([, item]) => item instanceof Promise)) {
      return Promise.all(
        entries.map(async ([key, item]) => [key, await item] as const),
      ).then((resolved) => Object.fromEntries(resolved));
    }
    return Object.fromEntries(entries);
  }

  private rememberVisibleModels(clientId: string, value: any) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) this.rememberVisibleModels(clientId, item);
      return;
    }
    if (typeof value['@M'] === 'string') {
      let clients = this.modelVisibility.get(value['@M']);
      if (!clients)
        this.modelVisibility.set(value['@M'], (clients = new Set()));
      clients.add(clientId);
    }
    for (const nested of Object.values(value))
      this.rememberVisibleModels(clientId, nested);
  }

  forwardForget(clientId: string, ids: SignalId[]) {
    const releasable: SignalId[] = [];
    for (const id of ids) {
      const marker =
        typeof id === 'string' && id.includes('#')
          ? (addPrefix(this.prefix, {'@M': id})['@M'] as string)
          : undefined;
      if (marker && this.modelVisibility.get(marker)?.has(clientId)) {
        const clients = this.modelVisibility.get(marker);
        clients?.delete(clientId);
        if (clients?.size === 0) this.modelVisibility.delete(marker);
        if (!this.modelVisibility.has(marker)) releasable.push(id);
      } else {
        const visible = this.signalVisibility.get(
          prefixSignalId(this.prefix, id),
        );
        visible?.delete(clientId);
        if (visible?.size === 0)
          this.signalVisibility.delete(prefixSignalId(this.prefix, id));
        const wasSubscribed = this.signalSubscriptions.get(id)?.has(clientId);
        this.forwardUnwatch(clientId, [id]);
        if (!this.signalSubscriptions.has(id) && !wasSubscribed) {
          this.latestSignalValues.delete(id);
          releasable.push(id);
        }
      }
    }
    if (releasable.length)
      this.transport.send(
        formatNotificationMessage(DROP_REFERENCES_METHOD, releasable),
      );
  }

  /**
   * Forward watch requests to the upstream.
   */
  forwardWatch(clientId: string, signalIds: SignalId[]) {
    const toWatch: SignalId[] = [];
    const finalIds: SignalId[] = [];

    for (const signalId of new Set(signalIds)) {
      if (this.finalSignalIds.has(signalId)) {
        finalIds.push(prefixSignalId(this.prefix, signalId));
        continue;
      }

      let subscribers = this.signalSubscriptions.get(signalId);
      const wasUnwatched = !subscribers || subscribers.size === 0;
      if (!subscribers) {
        subscribers = new Set();
        this.signalSubscriptions.set(signalId, subscribers);
      }

      subscribers.add(clientId);
      if (wasUnwatched) {
        toWatch.push(signalId);
      } else if (this.latestSignalValues.has(signalId)) {
        // The upstream watches once for all downstream clients. A later watcher
        // may have missed updates already forwarded to another client.
        const value = addPrefix(
          this.prefix,
          this.latestSignalValues.get(signalId),
        );
        this.sendPreparedUpdate(
          clientId,
          signalId,
          prefixSignalId(this.prefix, signalId),
          value,
          undefined,
          true,
        );
      }
    }

    if (toWatch.length > 0) {
      this.transport.send(
        formatNotificationMessage(WATCH_SIGNALS_METHOD, toWatch),
      );
    }
    for (const signalId of finalIds) {
      this.host.send(
        clientId,
        formatNotificationMessage(SIGNAL_UPDATE_METHOD, [
          signalId,
          null,
          'seal',
        ]),
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
        this.latestSignalValues.delete(signalId);
        toUnwatch.push(signalId);
      }
    }

    if (toUnwatch.length > 0) {
      this.transport.send(
        formatNotificationMessage(UNWATCH_SIGNALS_METHOD, toUnwatch),
      );
      this.transport.send(
        formatNotificationMessage(DROP_REFERENCES_METHOD, toUnwatch),
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
    this.clientGenerations.set(
      clientId,
      (this.clientGenerations.get(clientId) ?? 0) + 1,
    );
    this.updateVersions.delete(clientId);
    this.pendingUpdates.delete(clientId);
    this.clearPendingCallsForClient(clientId);

    const toForget: string[] = [];
    const orphanedSignals: SignalId[] = [];
    for (const [id, clients] of this.signalVisibility) {
      clients.delete(clientId);
      if (clients.size === 0) {
        this.signalVisibility.delete(id);
        orphanedSignals.push(stripSignalPrefix(this.prefix, id as string));
      }
    }
    for (const [marker, clients] of this.modelVisibility) {
      clients.delete(clientId);
      if (clients.size === 0) {
        this.modelVisibility.delete(marker);
        const hash = marker.lastIndexOf('#');
        toForget.push(
          `${marker.slice(0, hash + 1)}${stripInstancePrefix(this.prefix, marker.slice(hash + 1))}`,
        );
      }
    }
    if (toForget.length) {
      this.transport.send(
        formatNotificationMessage(DROP_REFERENCES_METHOD, toForget),
      );
    }

    const toUnwatch: SignalId[] = [];
    for (const [signalId, subscribers] of this.signalSubscriptions) {
      if (!subscribers.delete(clientId)) continue;

      if (subscribers.size === 0) {
        this.signalSubscriptions.delete(signalId);
        this.latestSignalValues.delete(signalId);
        toUnwatch.push(signalId);
      }
    }

    if (toUnwatch.length > 0) {
      this.transport.send(
        formatNotificationMessage(UNWATCH_SIGNALS_METHOD, toUnwatch),
      );
    }
    const released = new Set([...orphanedSignals, ...toUnwatch]);
    for (const id of released) {
      if (this.signalSubscriptions.has(id)) released.delete(id);
      else this.latestSignalValues.delete(id);
    }
    if (released.size) {
      this.transport.send(
        formatNotificationMessage(DROP_REFERENCES_METHOD, [...released]),
      );
    }
  }

  /**
   * Tear down this upstream connection entirely.
   */
  dispose() {
    this.disposed = true;
    this.clients.clear();
    this.clientGenerations.clear();
    this.updateVersions.clear();
    this.pendingUpdates.clear();
    this.signalSubscriptions.clear();
    this.modelVisibility.clear();
    this.signalVisibility.clear();
    this.latestSignalValues.clear();
    this.clearPendingCalls(new Error('Upstream disposed'));
  }
}
