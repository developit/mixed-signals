import {
  hydrateTree,
  PeerCodec,
  substituteBrandsAndCollectTransferables,
} from '../shared/codec.ts';
import {Hydrator} from '../shared/hydrate.ts';
import {
  PROMISE_REJECT_METHOD,
  PROMISE_RESOLVE_METHOD,
  ROOT_NOTIFICATION_METHOD,
  SIGNAL_UPDATE_METHOD,
  type Transport,
  type TransportContext,
  type WireMessage,
} from '../shared/protocol.ts';
import {
  SyncRPCAlreadyWaitedError,
  SyncRPCNoTransportWaitError,
  SyncRPCUnsupportedContextError,
} from '../sync/errors.ts';
import {
  claimForSync,
  isSyncablePromise,
  peekSyncableState,
  settleSyncable,
  type SyncablePromise,
} from '../sync/syncable-promise.ts';
import {ClientReflection} from './reflection.ts';

/**
 * Best-effort runtime check for whether `Atomics.wait` is usable from
 * the current context. Used by `RPCClient.canWait()` to gate the sync
 * path.
 *
 * Browser side: precise — returns `false` from main thread and
 * ServiceWorker, `true` only from DedicatedWorker / SharedWorker in a
 * cross-origin-isolated context.
 *
 * Node side: imprecise — we cannot statically tell main-thread vs
 * worker-thread without importing `node:worker_threads`, which would
 * pull a Node-only specifier into the client bundle. We optimistically
 * return `true` so legitimate Node workers report `canWait()` as
 * `true`; Node main-thread callers will see `Atomics.wait` throw at
 * call time, which surfaces the misuse loudly with a clear stack.
 * Consumers that need a precise check should use `supportsSync()` from
 * `mixed-signals/sync`, which resolves the Node-side detector through
 * the package's `node` subpath conditional export.
 */
function canCallAtomicsWaitInThisContext(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  if (typeof Atomics === 'undefined') return false;
  const g = globalThis as unknown as Record<string, unknown>;
  // Browser main thread — forbidden.
  if (typeof g.window !== 'undefined' && g.window === g) return false;
  // ServiceWorker — forbidden.
  if (typeof g.ServiceWorkerGlobalScope !== 'undefined') return false;
  // Browser worker: must be cross-origin-isolated.
  if (typeof g.WorkerGlobalScope !== 'undefined') {
    return !('crossOriginIsolated' in g) || g.crossOriginIsolated !== false;
  }
  // Non-browser context (Node, Deno, Bun, etc.). Assume usable; runtime
  // guard catches misuse from a non-worker context.
  return true;
}

/**
 * Client-side RPC hub.
 *
 * No model registration is required. Every incoming value is hydrated
 * automatically — Models and plain objects become `Proxy`s, functions become
 * callable proxies, promises become live `Promise`s, signals become real
 * `Signal`s wired to the watch/unwatch protocol.
 *
 * Works with either a `StringTransport` (the default — WebSocket, stdio,
 * etc.) or a `RawTransport` (postMessage / MessagePort / Worker). On the
 * raw path, outbound calls walk the arg tree to substitute branded remote
 * handles with `@H` markers and collect Transferable values into
 * `ctx.transfer`, which the transport hands to `postMessage(msg, ctx)`.
 */
export class RPCClient {
  private codec: PeerCodec;
  private transport: Transport;
  private nextId = 1;
  private pending = new Map<
    number,
    {resolve(v: any): void; reject(e: any): void}
  >();
  private notificationListeners = new Set<
    (method: string, params: any[]) => void
  >();

  /** @internal */
  reflection: ClientReflection;
  /** @internal */
  hydrator: Hydrator;

  private transportReady: Promise<void> | undefined;
  root: any = undefined;
  ready: Promise<void>;
  private _resolveReady!: () => void;

  constructor(transport: Transport, _ctx?: any) {
    this.transport = transport;
    this.transportReady = transport.ready;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.reflection = new ClientReflection(this);
    this.hydrator = new Hydrator(this.reflection);
    this.reflection.setHydrator(this.hydrator);
    this.codec = new PeerCodec(transport, (marker) =>
      this.hydrator.hydrate(marker),
    );
    this.wireCodec();
  }

  reconnect(transport: Transport) {
    this.transport = transport;
    this.transportReady = transport.ready;
    for (const {reject} of this.pending.values()) {
      reject(new Error('Transport reconnected'));
    }
    this.pending.clear();
    this.reflection.reset();
    this.hydrator.reset();
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.codec = new PeerCodec(transport, (marker) =>
      this.hydrator.hydrate(marker),
    );
    this.wireCodec();
  }

  private wireCodec() {
    this.codec.onMessage((msg) => {
      if (msg.type === 'result') {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        pending.resolve(msg.value);
        return;
      }
      if (msg.type === 'error') {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        pending.reject(
          new Error(
            ((msg.value as {message?: string}) ?? {}).message ?? 'RPC error',
          ),
        );
        return;
      }
      if (msg.type === 'call') return;

      this.handleNotification(msg.method, msg.params as any[]);
    });
  }

  async call(method: string, params?: any): Promise<any> {
    if (this.transportReady) await this.transportReady;
    return new Promise((resolve, reject) => {
      this._sendCall(method, params, {resolve, reject});
    });
  }

  /**
   * Fire one wire call with externally-supplied settle handlers. Shared
   * between the eager `call` API and the deferred `SyncablePromise`
   * lazy-send path that `ClientReflection.callSyncable` produces.
   *
   * Awaits `transportReady` internally so callers (including the
   * `SyncablePromise` auto-fire microtask) don't need to chain it
   * themselves. The eager `call` method awaits redundantly but that
   * resolves immediately if the transport is already ready.
   *
   * @internal
   */
  _sendCall(
    method: string,
    params: unknown[] | undefined,
    settle: {resolve(v: any): void; reject(e: any): void},
  ): void {
    const fire = () => {
      const id = this.nextId++;
      this.pending.set(id, settle);
      const ctx: TransportContext = {};
      const walked = substituteBrandsAndCollectTransferables(
        params || [],
        ctx,
        this.codec.encode,
      ) as unknown[];
      this.codec.send({type: 'call', id, method, params: walked}, ctx);
    };
    if (this.transportReady) {
      this.transportReady.then(fire, settle.reject);
    } else {
      fire();
    }
  }

  /**
   * True iff this client's transport implements a callable `wait?`
   * method AND the current context can call `Atomics.wait` (i.e. is a
   * worker thread with `SharedArrayBuffer` available). Returns `false`
   * from browser main threads, ServiceWorkers, non-COI contexts, and
   * contexts missing `SharedArrayBuffer` / `Atomics`.
   *
   * Node-side note: the context check is best-effort — from a Node
   * main thread with a `wait?`-capable transport, `canWait()` may
   * still return `true` because the client bundle can't import
   * `node:worker_threads` without pulling a Node-only specifier into
   * browser builds. The `Atomics.wait` call inside `wait()` throws if
   * actually invoked from Node main. For a precise pre-flight check
   * use `supportsSync()` from `mixed-signals/sync`.
   */
  canWait(): boolean {
    if (typeof this.transport.wait !== 'function') return false;
    return canCallAtomicsWaitInThisContext();
  }

  /**
   * Synchronously block on one or more in-flight RPC promises,
   * resolving them via a single SAB round-trip and returning their
   * hydrated values in input order.
   *
   * Each promise must be a `SyncablePromise` produced by this client's
   * proxy — an unconsumed result from `rpc.root.something.foo(...)`.
   * Mixing in already-consumed promises (awaited, `.then`-chained, or
   * passed to a prior `rpc.wait`) throws `SyncRPCAlreadyWaitedError`
   * synchronously, before any wire I/O.
   *
   * Results are hydrated through the same `Hydrator` path inbound
   * async responses take, so `o`, `f`, `s`, and `p` handles round-trip
   * with identical semantics — the same proxy identity, the same
   * brand round-tripping, the same class cache.
   *
   * Error semantics mirror `Promise.all`: every claimed promise is
   * settled (resolved or rejected) so any `.then` / `.catch` chains
   * the user attached run normally; this method then throws the first
   * error in input order.
   *
   * @throws SyncRPCNoTransportWaitError — the bound transport does not
   *   implement `wait?`. Configure the client with a sync-capable
   *   transport via `mixed-signals/sync`.
   * @throws SyncRPCAlreadyWaitedError — one of the supplied values is
   *   not a `SyncablePromise` from this client, or has already been
   *   consumed by `await`, `.then` / `.catch` / `.finally`, the
   *   auto-fire microtask, or a prior `rpc.wait`.
   * @throws SyncRPCTimeoutError — the host did not respond within
   *   `opts.timeoutMs`. There is no finite default (per design §14);
   *   the timeout fires only when the caller supplies one.
   * @throws SyncRPCIframeBridgeError — the SAB handshake failed in
   *   the iframe chain (e.g. an attempted cross-origin SAB transfer
   *   was rejected at the agent-cluster boundary; see design §6.3).
   *   Raised by `enableSyncClient`'s handshake path and surfaced
   *   through `rpc.wait` when the transport is built with the
   *   broker / relay helpers.
   * @throws SyncRPCUnsupportedContextError — the calling context
   *   cannot run `Atomics.wait` (browser main thread, ServiceWorker,
   *   or any context without `SharedArrayBuffer` / `Atomics`).
   *   This class is reserved for explicit pre-flight checks and the
   *   reentrancy throw site that future milestones wire; the actual
   *   `Atomics.wait` rejection from a main-thread caller surfaces
   *   as the JS engine's `TypeError` until then.
   * @throws SyncRPCReentrancyError — a method invoked on a sync-
   *   blocked client tried to call back into the same client, which
   *   would deadlock. The reentrancy throw site is wired in a later
   *   milestone; the class is declared here for forward
   *   compatibility of `instanceof` checks.
   * @throws RangeError — `promises` is empty; an empty wait is a
   *   programmer error.
   */
  wait<T extends readonly SyncablePromise<unknown>[]>(
    promises: T,
    opts?: {timeoutMs?: number},
  ): {
    [K in keyof T]: T[K] extends SyncablePromise<infer R> ? R : never;
  } {
    if (typeof this.transport.wait !== 'function') {
      throw new SyncRPCNoTransportWaitError(
        'rpc.wait(): transport does not implement wait(). Configure the ' +
          'client with a sync-capable transport (see mixed-signals/sync).',
      );
    }
    if (!canCallAtomicsWaitInThisContext()) {
      // Surface the documented `@throws SyncRPCUnsupportedContextError`
      // ahead of the engine's `TypeError` from a main-thread
      // `Atomics.wait`. A caller catching `SyncRPCError` (the family
      // root) gets a typed error to handle; without this gate the
      // failure surfaces as an untyped `TypeError`.
      throw new SyncRPCUnsupportedContextError(
        'rpc.wait(): the current context cannot call Atomics.wait. ' +
          'Sync RPC requires a worker context with SharedArrayBuffer; ' +
          'browser main threads, ServiceWorkers, and non-COI contexts ' +
          'are not supported.',
      );
    }
    if (promises.length === 0) {
      throw new RangeError(
        'rpc.wait(): promises array must not be empty',
      );
    }

    // Two-pass claim. Pass 1 validates every promise via a read-only
    // peek; if anything fails, throw before mutating anyone. Pass 2
    // claims atomically. The old single-pass loop claimed each promise
    // before validating the next, which leaked partial claims into a
    // permanent `consumed=true` zombie state if a later promise was
    // invalid — the block's own comment forbids that, but the
    // implementation achieved it.
    for (const p of promises) {
      const state = peekSyncableState(p);
      if (state === null) {
        throw new SyncRPCAlreadyWaitedError(
          'rpc.wait(): each argument must be a SyncablePromise from ' +
            "this client's proxy (e.g. rpc.root.foo()); received a " +
            'plain Promise or other value.',
        );
      }
      if (state.consumed) {
        throw new SyncRPCAlreadyWaitedError(
          `rpc.wait(): SyncablePromise already consumed by '${
            state.consumer ?? 'unknown path'
          }'.`,
        );
      }
    }
    const claimed = (promises as readonly SyncablePromise<unknown>[]).map(
      (p) => ({promise: p, descriptor: claimForSync(p)}),
    );

    // Build outbound WireMessages with brands substituted, using the
    // same walker the async path uses so brand round-trip semantics
    // are identical. The wire `id` is unused on the sync path — the
    // host wrapper re-stamps each call with a synth id starting at
    // 1,000,000 and the response is correlated positionally, not by
    // id — but we keep a non-zero placeholder so any future
    // assertions on `WireMessage.id !== 0` don't trip.
    const calls: WireMessage[] = claimed.map(({descriptor}) => {
      const ctx: TransportContext = {};
      const walkedParams = substituteBrandsAndCollectTransferables(
        descriptor.args,
        ctx,
        this.codec.encode,
      ) as unknown[];
      return {
        type: 'call',
        id: this.nextId++,
        method: descriptor.method,
        params: walkedParams,
      };
    });

    // Guard `transport.wait` so any throw (timeout, malformed handshake,
    // future payload-too-large, etc.) settles every already-claimed
    // promise with the error before propagating. Without this, claimed
    // promises stay `consumed=true` with no resolve/reject path —
    // `await` on them hangs forever. Matches the documented contract
    // "every claimed promise is settled".
    let results: WireMessage[];
    try {
      results = this.transport.wait(calls, opts);
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      for (const {promise} of claimed) {
        settleSyncable(promise, {ok: false, error: wrapped});
      }
      throw wrapped;
    }

    // Hydrate each value through the same path inbound messages take.
    // Identical hydration for sync and async is the contract that lets
    // `rpc.wait([rpc.foo()])[0]` produce the same proxy as
    // `await rpc.foo()` would.
    const hydrate = (v: unknown) =>
      hydrateTree(
        v,
        (marker) => this.hydrator.hydrate(marker),
        this.transport.decode,
      );

    // Settle every claimed promise first; only then throw the first
    // error. Mirrors `Promise.all` first-error-wins semantics adapted
    // to a batch we already have all responses for. Throwing mid-loop
    // would leave later promises claimed-but-unsettled — `await` on
    // them would hang forever.
    const out: unknown[] = new Array(results.length);
    let firstError: Error | undefined;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const {promise} = claimed[i]!;
      if (r?.type === 'result') {
        const hydrated = hydrate(r.value);
        settleSyncable(promise, {ok: true, value: hydrated});
        out[i] = hydrated;
      } else if (r?.type === 'error') {
        const hydrated = hydrate(r.value) as {message?: string} | undefined;
        const err = new Error(hydrated?.message ?? 'RPC error');
        settleSyncable(promise, {ok: false, error: err});
        out[i] = undefined;
        if (!firstError) firstError = err;
      } else {
        const err = new Error(
          `rpc.wait(): unexpected response type "${(r as {type?: string})?.type ?? 'undefined'}"`,
        );
        settleSyncable(promise, {ok: false, error: err});
        out[i] = undefined;
        if (!firstError) firstError = err;
      }
    }
    if (firstError) throw firstError;
    return out as {
      [K in keyof T]: T[K] extends SyncablePromise<infer R> ? R : never;
    };
  }

  /**
   * Resolve the constructor for a remote class by name. Every class instance
   * the client has hydrated is built on a shared prototype, so you can use
   * the returned function with `instanceof`:
   *
   *   const Counter = client.classOf('Counter');
   *   value instanceof Counter;
   *
   * Returns `undefined` if no instance of a class with that name has been
   * received yet.
   */
  classOf(name: string): (new () => any) | undefined {
    return this.hydrator.classOf(name);
  }

  notify(method: string, params?: any[]) {
    const sendIt = () => {
      const ctx: TransportContext = {};
      const walked = substituteBrandsAndCollectTransferables(
        params || [],
        ctx,
        this.codec.encode,
      ) as unknown[];
      this.codec.send({type: 'notification', method, params: walked}, ctx);
    };
    if (this.transportReady) {
      this.transportReady.then(sendIt);
    } else {
      sendIt();
    }
  }

  onNotification(cb: (method: string, params: any[]) => void): () => void {
    this.notificationListeners.add(cb);
    return () => this.notificationListeners.delete(cb);
  }

  private handleNotification(method: string, params: any[]) {
    if (method === ROOT_NOTIFICATION_METHOD) {
      this.root = params[0];
      this._resolveReady();
    } else if (method === SIGNAL_UPDATE_METHOD) {
      const [id, value, mode] = params as [string, any, string?];
      this.hydrator.applySignalUpdate(id, value, mode);
    } else if (method === PROMISE_RESOLVE_METHOD) {
      const [id, value] = params as [string, any];
      this.reflection.settlePromise(id, value, false);
    } else if (method === PROMISE_REJECT_METHOD) {
      const [id, value] = params as [string, any];
      this.reflection.settlePromise(id, value, true);
    } else {
      for (const listener of this.notificationListeners) {
        listener(method, params);
      }
    }
  }
}
