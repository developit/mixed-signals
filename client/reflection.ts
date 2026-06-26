import {type Signal, Signal as SignalCtor, signal} from '@preact/signals-core';
import {
  UNWATCH_SIGNALS_METHOD,
  WATCH_SIGNALS_METHOD,
} from '../shared/protocol.ts';
import {
  REFRESH_REFLECTED_MODEL,
  type RefreshableReflectedModel,
} from './model.ts';
import type {RPCClient} from './rpc.ts';

/** @internal */
export interface WireContext {
  rpc: RPCClient;
}

type SignalId = number | string;

const WATCH_FLUSH_DELAY = 10;

function uniqueSignalIds(ids: Array<SignalId | undefined>): SignalId[] {
  const unique = new Set<SignalId>();
  for (const id of ids) {
    if (id !== undefined) unique.add(id);
  }
  return Array.from(unique);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export class ClientReflection {
  private signals = new Map<SignalId, Signal<any>>();
  private signalIds = new WeakMap<Signal<any>, SignalId>();
  private activeSignals = new Set<Signal<any>>();
  private models = new Map<string, any>();
  private modelRegistry = new Map<string, any>();
  private rpc: RPCClient;
  private ctx: WireContext;
  private static queuedWatchFlushes = new Set<ClientReflection>();
  private static watchFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private watchedSignals = new Set<Signal<any>>();
  private watchBatch = new Set<Signal<any>>();
  private unwatchBatch = new Set<Signal<any>>();

  constructor(rpc: RPCClient, ctx?: any) {
    this.rpc = rpc;
    this.ctx = ctx && ctx.rpc === rpc ? ctx : {rpc};
  }

  /** Clear all cached client state. Prefer prepareReconnect() for reconnects. */
  reset() {
    this.clearPendingWatchTraffic();
    this.signals.clear();
    this.signalIds = new WeakMap();
    this.activeSignals.clear();
    this.models.clear();
    this.watchedSignals.clear();
  }

  /**
   * Keep cached signals/models alive, but discard pending watch traffic tied to
   * the old transport generation. The next root snapshot will refresh/rebind
   * them and replayActiveSignals() will subscribe the new connection.
   */
  prepareReconnect() {
    this.clearPendingWatchTraffic();
    this.watchedSignals.clear();
  }

  /**
   * Drop raw wire-id mappings when a different server process owns the next
   * snapshot. Existing signal objects stay alive and can be rebound as the new
   * root/model snapshots identify their replacement wire ids.
   */
  prepareProcessChange() {
    this.prepareReconnect();
    this.signals.clear();
    this.signalIds = new WeakMap();
  }

  /** Replay all currently watched signal ids on a freshly connected transport. */
  replayActiveSignals(exclude?: Iterable<SignalId>): SignalId[] {
    this.clearPendingWatchTraffic();
    const excluded = exclude ? new Set(exclude) : undefined;
    const signals = Array.from(this.activeSignals).filter((sig) => {
      const id = this.signalIds.get(sig);
      return id !== undefined && !excluded?.has(id);
    });
    const ids = uniqueSignalIds(signals.map((sig) => this.signalIds.get(sig)));
    if (ids.length > 0) {
      for (const sig of signals) this.watchedSignals.add(sig);
      this.rpc.notify(WATCH_SIGNALS_METHOD, ids);
    }
    return ids;
  }

  registerModel(typeName: string, ctor: any) {
    this.modelRegistry.set(typeName, ctor);
  }

  getModelMarkers(): string[] {
    return Array.from(this.models.keys());
  }

  private clearPendingWatchTraffic() {
    ClientReflection.queuedWatchFlushes.delete(this);
    if (
      ClientReflection.queuedWatchFlushes.size === 0 &&
      ClientReflection.watchFlushTimer
    ) {
      clearTimeout(ClientReflection.watchFlushTimer);
      ClientReflection.watchFlushTimer = null;
    }
    this.watchBatch.clear();
    this.unwatchBatch.clear();
  }

  private rememberSignal(id: SignalId, sig: Signal<any>) {
    const previousId = this.signalIds.get(sig);
    if (previousId !== undefined && previousId !== id) {
      if (this.signals.get(previousId) === sig) {
        this.signals.delete(previousId);
      }
    }

    this.signals.set(id, sig);
    this.signalIds.set(sig, id);
  }

  private static queueGlobalWatchFlush() {
    if (ClientReflection.watchFlushTimer) return;

    ClientReflection.watchFlushTimer = setTimeout(() => {
      ClientReflection.watchFlushTimer = null;
      ClientReflection.flushQueuedWatches();
    }, WATCH_FLUSH_DELAY);
  }

  private static flushQueuedWatches() {
    const reflections = Array.from(ClientReflection.queuedWatchFlushes);
    ClientReflection.queuedWatchFlushes.clear();

    for (const reflection of reflections) {
      reflection.flushWatches();
    }
  }

  private queueWatchFlush() {
    ClientReflection.queuedWatchFlushes.add(this);
    ClientReflection.queueGlobalWatchFlush();
  }

  private scheduleWatch(sig: Signal<any>) {
    this.unwatchBatch.delete(sig);

    if (!this.watchedSignals.has(sig)) {
      this.watchBatch.add(sig);
      this.queueWatchFlush();
    }
  }

  private scheduleUnwatch(sig: Signal<any>) {
    this.watchBatch.delete(sig);

    if (this.watchedSignals.has(sig)) {
      this.unwatchBatch.add(sig);
      this.queueWatchFlush();
    }
  }

  private flushWatches() {
    const watchSignals = Array.from(this.watchBatch).filter(
      (sig) =>
        this.activeSignals.has(sig) &&
        !this.watchedSignals.has(sig) &&
        this.signalIds.get(sig) !== undefined,
    );
    const unwatchSignals = Array.from(this.unwatchBatch).filter(
      (sig) =>
        !this.activeSignals.has(sig) &&
        this.watchedSignals.has(sig) &&
        this.signalIds.get(sig) !== undefined,
    );
    this.watchBatch.clear();
    this.unwatchBatch.clear();

    const watchIds = uniqueSignalIds(
      watchSignals.map((sig) => this.signalIds.get(sig)),
    );
    if (watchIds.length > 0) {
      for (const sig of watchSignals) this.watchedSignals.add(sig);
      this.rpc.notify(WATCH_SIGNALS_METHOD, watchIds);
    }

    const unwatchIds = uniqueSignalIds(
      unwatchSignals.map((sig) => this.signalIds.get(sig)),
    );
    if (unwatchIds.length > 0) {
      for (const sig of unwatchSignals) this.watchedSignals.delete(sig);
      this.rpc.notify(UNWATCH_SIGNALS_METHOD, unwatchIds);
    }
  }

  getOrCreateSignal(id: SignalId, initialValue: any): Signal<any> {
    const existingSignal = this.signals.get(id);
    if (existingSignal) return existingSignal;

    let createdSignal!: Signal<any>;

    createdSignal = signal(initialValue, {
      watched: () => {
        this.activeSignals.add(createdSignal);
        // Only tell the server once the client actually observes this signal.
        this.scheduleWatch(createdSignal);
      },
      unwatched: () => {
        // Debounce unwatch so transient unmount/remount cycles stay subscribed.
        this.activeSignals.delete(createdSignal);
        this.scheduleUnwatch(createdSignal);
      },
    });

    this.rememberSignal(id, createdSignal);
    return createdSignal;
  }

  syncSignalSnapshot(id: SignalId, value: any): Signal<any> {
    const sig = this.getOrCreateSignal(id, value);
    sig.value = value;
    return sig;
  }

  reconcileRoot(previousRoot: any, nextRoot: any): any {
    // Preserve only identities the protocol can prove. The root shell is kept
    // stable for ergonomics, but unbranded nested objects/arrays are replaced.
    if (isPlainObject(previousRoot) && isPlainObject(nextRoot)) {
      for (const key of Object.keys(previousRoot)) {
        if (!(key in nextRoot)) {
          delete previousRoot[key];
        }
      }

      for (const [key, value] of Object.entries(nextRoot)) {
        previousRoot[key] = this.reconcileIdentifiedValue(
          previousRoot[key],
          value,
        );
      }

      return previousRoot;
    }

    return this.reconcileIdentifiedValue(previousRoot, nextRoot);
  }

  /** @internal */
  syncSignalIdentity(
    previousSignal: Signal<any>,
    nextSignal: Signal<any>,
  ): Signal<any> {
    return this.rebindSignal(previousSignal, nextSignal);
  }

  private reconcileIdentifiedValue(previousValue: any, nextValue: any): any {
    if (previousValue === nextValue) return previousValue;

    if (
      previousValue instanceof SignalCtor &&
      nextValue instanceof SignalCtor
    ) {
      return this.rebindSignal(previousValue, nextValue);
    }

    return nextValue;
  }

  private rebindSignal(
    previousSignal: Signal<any>,
    nextSignal: Signal<any>,
  ): Signal<any> {
    const nextId = this.signalIds.get(nextSignal);
    if (nextId !== undefined) {
      this.rememberSignal(nextId, previousSignal);
    }

    if (this.activeSignals.has(nextSignal)) {
      this.activeSignals.delete(nextSignal);
      this.activeSignals.add(previousSignal);
    }

    previousSignal.value = nextSignal.peek();
    return previousSignal;
  }

  createModelFacade(serialized: any): any {
    const raw: string = serialized['@M'];
    if (!raw) {
      throw new Error('Model missing @M field');
    }

    // Models are branded as TypeName#wireId so the facade knows both pieces.
    const hashIdx = raw.lastIndexOf('#');
    const typeName = hashIdx !== -1 ? raw.slice(0, hashIdx) : raw;
    const wireId = hashIdx !== -1 ? raw.slice(hashIdx + 1) : undefined;
    const data = {...serialized, '@wireId': wireId};

    const existing = this.models.get(raw) as
      | RefreshableReflectedModel
      | undefined;
    if (existing) {
      existing[REFRESH_REFLECTED_MODEL]?.(data);
      return existing;
    }

    const ModelCtor = this.modelRegistry.get(typeName);
    if (!ModelCtor) {
      throw new Error(`Unknown model type: ${typeName}`);
    }

    const model = new ModelCtor(this.ctx, data);
    this.models.set(raw, model);
    return model;
  }

  handleUpdate(id: SignalId, value: any, mode?: string) {
    const sig = this.signals.get(id);
    if (!sig) return;

    if (!mode) {
      sig.value = value;
      return;
    }

    const current = sig.value;

    switch (mode) {
      case 'append':
        // Streaming text and immutable array pushes both land here.
        if (Array.isArray(current)) {
          sig.value = [...current, ...value];
        } else if (typeof current === 'string') {
          sig.value = current + value;
        }
        break;

      case 'merge':
        if (current && typeof current === 'object') {
          sig.value = {...current, ...value};
        }
        break;

      case 'splice':
        // Reserved for richer array diffs; keep client support even if rare today.
        if (Array.isArray(current)) {
          const {start, deleteCount, items} = value;
          const nextArray = [...current];
          nextArray.splice(start, deleteCount, ...items);
          sig.value = nextArray;
        }
        break;

      default:
        sig.value = value;
    }
  }
}
