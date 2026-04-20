import {Handles} from '../shared/handles.ts';
import {
  formatErrorMessage,
  formatNotificationMessage,
  formatResultMessage,
  HANDLE_MARKER,
  parseWireMessage,
  parseWireParams,
  RELEASE_HANDLES_METHOD,
  ROOT_NOTIFICATION_METHOD,
  type Transport,
  UNWATCH_SIGNALS_METHOD,
  WATCH_SIGNALS_METHOD,
} from '../shared/protocol.ts';
import {
  ForwardedUpstream,
  isUpstreamId,
  stripInstancePrefix,
  stripSignalPrefix,
} from './forwarding.ts';
import {Reflection} from './reflection.ts';

export type RetentionPolicy =
  | {kind: 'disconnect'}
  | {kind: 'ttl'; idleMs: number; sweepMs?: number}
  | {kind: 'weak'};

export interface RPCOptions {
  /**
   * When the server should auto-release handles with no client refs.
   * Default is `{kind: 'ttl', idleMs: 30_000}` — reclaimed 30s after the last
   * release. `disconnect` releases on client disconnect only. `weak` uses
   * WeakRefs at the registry level.
   */
  retention?: RetentionPolicy;
}

const DEFAULT_RETENTION: RetentionPolicy = {kind: 'ttl', idleMs: 30_000};

// Allow dotted paths for nested method calls like "sessions.createSession".
function dlv(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

/**
 * Server-side RPC hub. Owns:
 *   - A shared `Handles` registry (ids for signals, models, plain objects,
 *     functions, promises).
 *   - A `Reflection` instance that manages signal subscriptions and delta
 *     pushes for every connected client.
 *   - Transport bookkeeping per connected client.
 *
 * There is no `registerModel`. Use `createModel(name, factory)` — the name is
 * stamped on the ctor and the serializer picks it up automatically.
 */
export class RPC {
  private clients = new Map<string, Transport>();
  private root: any;
  private retention: RetentionPolicy;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;

  /** @internal */
  handles: Handles;
  /** @internal */
  reflection: Reflection;

  private upstreams = new Map<string, ForwardedUpstream>();
  private nextUpstreamPrefix = 1;

  constructor(root?: any, options: RPCOptions = {}) {
    this.handles = new Handles();
    this.reflection = new Reflection(this, this.handles);
    this.retention = options.retention ?? DEFAULT_RETENTION;

    if (root !== undefined) this.expose(root);
  }

  /**
   * Register an upstream mixed-signals connection whose handles are
   * transparently forwarded to downstream clients. All handles are
   * auto-forwarded — no per-type declaration needed.
   */
  addUpstream(transport: Transport): () => void {
    const prefix = String(this.nextUpstreamPrefix++);
    const upstream = new ForwardedUpstream(prefix, transport, this);
    this.upstreams.set(prefix, upstream);
    for (const clientId of this.clients.keys()) upstream.setClient(clientId);
    return () => {
      upstream.dispose();
      this.upstreams.delete(prefix);
    };
  }

  /** @internal — ForwardedUpstream calls this when upstream root arrives. */
  onUpstreamRootChanged() {
    if (!this.allUpstreamsReady()) return;
    for (const clientId of this.clients.keys())
      this.broadcastMergedRoot(clientId);
  }

  private allUpstreamsReady(): boolean {
    for (const upstream of this.upstreams.values()) {
      if (upstream.root === undefined) return false;
    }
    return true;
  }

  private broadcastMergedRoot(clientId: string) {
    const localRoot =
      this.root !== undefined
        ? this.reflection.serialize(this.root, clientId)
        : undefined;
    let merged = localRoot;
    for (const upstream of this.upstreams.values()) {
      if (upstream.root) {
        if (merged && typeof merged === 'object' && !Array.isArray(merged)) {
          merged = {...merged, ...upstream.root};
        } else {
          merged = upstream.root;
        }
      }
    }
    if (merged !== undefined) {
      this.send(
        clientId,
        formatNotificationMessage(ROOT_NOTIFICATION_METHOD, [merged]),
      );
    }
  }

  expose(root: any) {
    this.root = root;
    // The root is always id "o0" so clients can reference it with a bare "o0"
    // in method paths if they want to. Most calls use the dotted method path
    // ("sessions.create") and never touch the root id directly.
    this.handles.registerWithId('o0', 'o', root);
  }

  addClient(transport: Transport, clientId?: string): () => void {
    const id = clientId ?? crypto.randomUUID();
    // If the same id is reconnecting, drop per-client caches so shapes and
    // model names are re-sent inline on the first emission after reconnect.
    if (this.clients.has(id)) {
      this.reflection.removeClient(id);
      this.handles.releaseAllForClient(id);
    }
    this.clients.set(id, transport);

    for (const upstream of this.upstreams.values()) upstream.setClient(id);

    const reviver = this.makeIncomingReviver();
    transport.onMessage(async (data) => {
      try {
        const raw = data.toString();
        if (this.tryForwardClientMessage(id, raw)) return;
        const message = parseWireMessage(raw);
        if (!message || message.type === 'result' || message.type === 'error')
          return;
        // Only call-paths carry rpc-controlled messages; @W/@U/@D payloads
        // are plain scalars and the reviver is a no-op for them.
        const params = parseWireParams(message.payload, reviver);
        const messageId = message.type === 'call' ? message.id : undefined;
        await this.handleMessage(id, messageId, message.method, params);
      } catch (err) {
        console.error('Failed to handle message:', err);
      }
    });

    // Send the root as a structured notification; the client hydrates via the
    // usual reviver. If no root was exposed, we still fire `@R` with null so
    // the client's `ready` promise resolves. If any upstream is still pending,
    // `onUpstreamRootChanged` will send the merged root later.
    if (this.upstreams.size === 0) {
      const serialized =
        this.root !== undefined
          ? this.reflection.serialize(this.root, id)
          : null;
      this.send(
        id,
        formatNotificationMessage(ROOT_NOTIFICATION_METHOD, [serialized]),
      );
    } else if (this.allUpstreamsReady()) {
      this.broadcastMergedRoot(id);
    }

    return () => this.removeClient(id);
  }

  removeClient(clientId: string) {
    this.clients.delete(clientId);
    this.reflection.removeClient(clientId);
    for (const upstream of this.upstreams.values())
      upstream.removeClient(clientId);
    const orphaned = this.handles.releaseAllForClient(clientId);
    if (this.retention.kind === 'disconnect') {
      for (const id of orphaned) {
        if (id === 'o0') continue; // root survives disconnects
        this.dropHandle(id);
      }
    } else if (this.retention.kind === 'ttl') {
      this.scheduleTtlSweep();
    }
  }

  // ───── forwarding dispatch ───────────────────────────────────────────

  private tryForwardClientMessage(clientId: string, raw: string): boolean {
    if (this.upstreams.size === 0) return false;
    const parsed = parseWireMessage(raw);
    if (!parsed) return false;

    if (
      parsed.type === 'notification' &&
      (parsed.method === WATCH_SIGNALS_METHOD ||
        parsed.method === UNWATCH_SIGNALS_METHOD ||
        parsed.method === RELEASE_HANDLES_METHOD)
    ) {
      const ids = parseWireParams<string[]>(parsed.payload);
      const localIds: string[] = [];
      const upstreamBatches = new Map<ForwardedUpstream, string[]>();
      for (const id of ids) {
        const upstream = this.findUpstreamForId(id);
        if (upstream) {
          let batch = upstreamBatches.get(upstream);
          if (!batch) {
            batch = [];
            upstreamBatches.set(upstream, batch);
          }
          batch.push(stripSignalPrefix(upstream.prefix, id));
        } else {
          localIds.push(id);
        }
      }
      if (upstreamBatches.size === 0) return false;
      for (const [upstream, batch] of upstreamBatches) {
        if (parsed.method === WATCH_SIGNALS_METHOD)
          upstream.forwardWatch(batch);
        else if (parsed.method === UNWATCH_SIGNALS_METHOD)
          upstream.forwardUnwatch(batch);
        else upstream.forwardRelease(batch);
      }
      for (const id of localIds) {
        if (parsed.method === WATCH_SIGNALS_METHOD)
          this.reflection.watch(clientId, id);
        else if (parsed.method === UNWATCH_SIGNALS_METHOD)
          this.reflection.unwatch(clientId, id);
        else this.handleRelease(clientId, id);
      }
      return true;
    }

    if (parsed.type === 'call') {
      const hashIdx = parsed.method.indexOf('#');
      if (hashIdx !== -1) {
        const handleId = parsed.method.slice(0, hashIdx);
        const upstream = this.findUpstreamForId(handleId);
        if (upstream) {
          const stripped = stripInstancePrefix(upstream.prefix, handleId);
          const methodName = parsed.method.slice(hashIdx + 1);
          upstream.forwardCall(
            clientId,
            parsed.id,
            `${stripped}#${methodName}`,
            parsed.payload,
          );
          return true;
        }
      } else {
        // Bare function-handle call (e.g. "f7").
        const upstream = this.findUpstreamForId(parsed.method);
        if (upstream) {
          const stripped = stripInstancePrefix(upstream.prefix, parsed.method);
          upstream.forwardCall(clientId, parsed.id, stripped, parsed.payload);
          return true;
        }
      }
    }
    return false;
  }

  private findUpstreamForId(id: string): ForwardedUpstream | undefined {
    for (const upstream of this.upstreams.values()) {
      if (isUpstreamId(upstream.prefix, id)) return upstream;
    }
    return undefined;
  }

  /**
   * Reviver that resolves incoming `@H` markers back to live server values.
   * A client that received a branded Proxy and is passing it back as an
   * argument will emit `{"@H":"o17"}` — this lets the server see the actual
   * object instead of a plain `{}`.
   */
  private makeIncomingReviver(): (key: string, value: any) => any {
    return (_key, value) => {
      if (value && typeof value === 'object' && HANDLE_MARKER in value) {
        const id = value[HANDLE_MARKER];
        const entry = this.handles.get(id);
        if (entry) return entry.value;
        // Unknown id (client never received it from us, or we've already freed
        // it under the retention policy): return null rather than throwing.
        return null;
      }
      return value;
    };
  }

  notify(method: string, params: any[], clientId?: string) {
    const message = formatNotificationMessage(method, params);
    if (clientId) this.clients.get(clientId)?.send(message);
    else for (const t of this.clients.values()) t.send(message);
  }

  /** @internal */
  send(clientId: string, message: string) {
    this.clients.get(clientId)?.send(message);
  }

  // ───── message dispatch ────────────────────────────────────────────────────

  private async handleMessage(
    clientId: string,
    id: number | undefined,
    method: string,
    params: any[],
  ) {
    if (method === WATCH_SIGNALS_METHOD) {
      for (const signalId of params) this.reflection.watch(clientId, signalId);
      return;
    }
    if (method === UNWATCH_SIGNALS_METHOD) {
      for (const signalId of params)
        this.reflection.unwatch(clientId, signalId);
      return;
    }
    if (method === RELEASE_HANDLES_METHOD) {
      for (const handleId of params) this.handleRelease(clientId, handleId);
      return;
    }

    try {
      const result = await this.callMethod(method, params);
      const serialized = this.reflection.serialize(result, clientId);
      if (id !== undefined) {
        this.send(clientId, formatResultMessage(id, serialized));
      }
    } catch (error: any) {
      if (id !== undefined) {
        this.send(
          clientId,
          formatErrorMessage(id, {
            code: -1,
            message: error?.message ?? String(error),
          }),
        );
      }
    }
  }

  private async callMethod(method: string, params: any): Promise<any> {
    const args = params || [];

    // "<handleId>#<method>" — call a method on a handle.
    const hashIdx = method.indexOf('#');
    if (hashIdx !== -1) {
      const handleId = method.slice(0, hashIdx);
      const rest = method.slice(hashIdx + 1);
      const instance = this.handles.valueOf(handleId);
      if (instance == null) {
        throw new Error(`Handle not found: ${handleId}`);
      }
      this.handles.touch(handleId);
      const segments = rest.split('.');
      const methodName = segments.pop()!;
      const receiver =
        segments.length > 0 ? dlv(instance, segments.join('.')) : instance;
      const target = receiver?.[methodName];
      if (typeof target !== 'function') {
        throw new Error(`Method not found: ${rest} on ${handleId}`);
      }
      return target.apply(receiver, args);
    }

    // "<fnHandleId>" — bare function handle call. We only match when the
    // whole method string looks like an `f<digits>` id AND that id exists in
    // the handles table. Any other name falls through to the dotted-path
    // dispatcher so method names like `fail` still work on the root.
    if (/^f\d/.test(method)) {
      const entry = this.handles.get(method);
      if (entry && typeof entry.value === 'function') {
        this.handles.touch(method);
        return entry.value(...args);
      }
    }

    // Dotted path on the root.
    const segments = method.split('.');
    const methodName = segments.pop()!;
    const receiver =
      segments.length > 0 ? dlv(this.root, segments.join('.')) : this.root;
    const target = receiver?.[methodName];
    if (typeof target !== 'function') {
      throw new Error(`Method not found: ${method}`);
    }
    return target.apply(receiver, args);
  }

  // ───── retention ───────────────────────────────────────────────────────────

  private handleRelease(clientId: string, handleId: string) {
    // Only object (o) and function (f) handles participate in release.
    // Signals are driven by @W/@U; promises are one-shot and don't track refs.
    const kind = handleId[0];
    if (kind !== 'o' && kind !== 'f') return;
    const fullyOrphaned = this.handles.release(handleId, clientId);
    if (fullyOrphaned) {
      if (this.retention.kind === 'disconnect') {
        // "disconnect" means don't drop on normal release — keep until the
        // client actually disconnects. (This matches the semantics the name
        // implies, and avoids surprising removals while the client's still
        // there.) TTL is the default; this branch is for opt-in use only.
      } else if (this.retention.kind === 'ttl') {
        this.scheduleTtlSweep();
      } else if (this.retention.kind === 'weak') {
        this.dropHandle(handleId);
      }
    }
  }

  private dropHandle(handleId: string) {
    const entry = this.handles.get(handleId);
    if (!entry) return;
    if (entry.kind === 's') this.reflection.forgetSignal(handleId);
    this.handles.drop(handleId);
  }

  private scheduleTtlSweep() {
    if (this.ttlTimer || this.retention.kind !== 'ttl') return;
    const sweepMs =
      this.retention.sweepMs ?? Math.max(1_000, this.retention.idleMs / 4);
    this.ttlTimer = setTimeout(() => {
      this.ttlTimer = null;
      this.sweepTtl();
    }, sweepMs);
  }

  private sweepTtl() {
    if (this.retention.kind !== 'ttl') return;
    const now = Date.now();
    const idleMs = this.retention.idleMs;
    const toDrop: string[] = [];
    for (const entry of this.handles.allEntries()) {
      if (entry.id === 'o0') continue; // never drop root
      if (entry.refs.size > 0) continue;
      if (now - entry.lastTouched < idleMs) continue;
      toDrop.push(entry.id);
    }
    for (const id of toDrop) this.dropHandle(id);
    // If there's still orphaned-but-fresh state, schedule another sweep.
    for (const entry of this.handles.allEntries()) {
      if (entry.refs.size === 0 && entry.id !== 'o0') {
        this.scheduleTtlSweep();
        break;
      }
    }
  }

  /**
   * Shut the RPC down: disconnect all clients, dispose upstreams, cancel any
   * pending timers. After `close()` the instance must not be reused.
   */
  close() {
    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
    for (const id of Array.from(this.clients.keys())) this.removeClient(id);
    for (const upstream of this.upstreams.values()) upstream.dispose();
    this.upstreams.clear();
  }

  /** @internal — test hook. */
  _sweepTtlNow() {
    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
    this.sweepTtl();
  }
}
