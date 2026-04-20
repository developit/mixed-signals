import type {HydrateEnv, Hydrator} from '../shared/hydrate.ts';
import {
  RELEASE_HANDLES_METHOD,
  UNWATCH_SIGNALS_METHOD,
  WATCH_SIGNALS_METHOD,
} from '../shared/protocol.ts';
import type {RPCClient} from './rpc.ts';

/** @internal — retained for the optional context parameter to `RPCClient`. */
export interface WireContext {
  rpc: RPCClient;
}

/**
 * Owns outbound batching: @W, @U, @D. All three use the same debounce pattern
 * (1ms for watch/release bursts, 10ms for unwatch so quick remounts stay
 * subscribed). The actual hydration is delegated to the shared `Hydrator`.
 */
export class ClientReflection implements HydrateEnv {
  private rpc: RPCClient;

  private watchBatch = new Set<string>();
  private unwatchBatch = new Set<string>();
  private releaseBatch = new Set<string>();
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private unwatchTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  private pendingPromises = new Map<
    string,
    {resolve(v: any): void; reject(e: any): void}
  >();

  /** @internal */
  hydrator!: Hydrator;

  constructor(rpc: RPCClient, _ctx?: any) {
    this.rpc = rpc;
  }

  setHydrator(h: Hydrator) {
    this.hydrator = h;
  }

  reset() {
    this.watchBatch.clear();
    this.unwatchBatch.clear();
    this.releaseBatch.clear();
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.unwatchTimer) clearTimeout(this.unwatchTimer);
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.watchTimer = null;
    this.unwatchTimer = null;
    this.releaseTimer = null;
    this.pendingPromises.clear();
  }

  // ───── HydrateEnv ──────────────────────────────────────────────────────────

  call(method: string, args: readonly unknown[]): Promise<any> {
    return this.rpc.call(method, args);
  }

  scheduleWatch(id: string): void {
    this.watchBatch.add(id);
    if (!this.watchTimer) {
      this.watchTimer = setTimeout(() => {
        const ids = Array.from(this.watchBatch);
        this.watchBatch.clear();
        this.watchTimer = null;
        if (ids.length) this.rpc.notify(WATCH_SIGNALS_METHOD, ids);
      }, 1);
    }
  }

  scheduleUnwatch(id: string): void {
    this.unwatchBatch.add(id);
    if (!this.unwatchTimer) {
      this.unwatchTimer = setTimeout(() => {
        const ids = Array.from(this.unwatchBatch);
        this.unwatchBatch.clear();
        this.unwatchTimer = null;
        if (ids.length) this.rpc.notify(UNWATCH_SIGNALS_METHOD, ids);
      }, 1);
    }
  }

  scheduleRelease(id: string): void {
    // Only object (o) and function (f) handles participate in refcounted
    // release. Signals (s) are driven by @W/@U. Promises (p) are one-shot.
    // We never register those with the FinalizationRegistry, but filter here
    // too so manual callers (e.g. Symbol.dispose) can't accidentally send
    // release frames for kinds that shouldn't carry them.
    const kind = id[0];
    if (kind !== 'o' && kind !== 'f') return;
    this.releaseBatch.add(id);
    if (!this.releaseTimer) {
      // Slightly longer — finalization callbacks come in bursts.
      this.releaseTimer = setTimeout(() => {
        const ids = Array.from(this.releaseBatch);
        this.releaseBatch.clear();
        this.releaseTimer = null;
        if (ids.length) this.rpc.notify(RELEASE_HANDLES_METHOD, ids);
      }, 16);
    }
  }

  registerPendingPromise(
    id: string,
    settle: {resolve(v: any): void; reject(e: any): void},
  ): void {
    this.pendingPromises.set(id, settle);
  }

  /** @internal — called by the client RPC on @P / @E notifications. */
  settlePromise(id: string, value: any, reject: boolean) {
    const entry = this.pendingPromises.get(id);
    if (!entry) return;
    this.pendingPromises.delete(id);
    if (reject) entry.reject(new Error(value?.message ?? 'RPC error'));
    else entry.resolve(value);
  }
}
