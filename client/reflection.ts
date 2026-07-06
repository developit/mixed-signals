import {type Signal, Signal as SignalCtor, signal} from '@preact/signals-core';
import {
  REFRESH_MODELS_METHOD,
  UNWATCH_SIGNALS_METHOD,
  WATCH_SIGNALS_METHOD,
} from '../shared/protocol.ts';
import {
  GET_REFLECTED_MODEL_SIGNALS,
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

type CacheRef<T extends object> = WeakRef<T> | StrongCacheRef<T>;

class StrongCacheRef<T extends object> {
  constructor(private value: T) {}

  deref(): T {
    return this.value;
  }
}

const weakRefsAvailable = typeof WeakRef !== 'undefined';

function createCacheRef<T extends object>(value: T): CacheRef<T> {
  return weakRefsAvailable ? new WeakRef(value) : new StrongCacheRef(value);
}

export class ClientReflection {
  private signals = new Map<SignalId, CacheRef<Signal<any>>>();
  private signalIds = new WeakMap<Signal<any>, SignalId>();
  private signalFinalizerTokens = new WeakMap<Signal<any>, object>();
  private signalFinalizer?: FinalizationRegistry<SignalId>;
  private activeSignals = new Set<Signal<any>>();
  private models = new Map<string, CacheRef<object>>();
  private modelFinalizerTokens = new WeakMap<object, object>();
  private modelFinalizer?: FinalizationRegistry<string>;
  private modelSignals = new Map<string, Set<CacheRef<Signal<any>>>>();
  private refreshedRootModelMarkers = new Set<string>();
  private staleModelMarkers = new Set<string>();
  private refreshingModelMarkers = new Set<string>();
  private modelRefreshGeneration = 0;
  private collectingRootModels = false;
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

    if (weakRefsAvailable && typeof FinalizationRegistry !== 'undefined') {
      // Finalizers are cache hygiene only. A wire id or marker may be rebound
      // to a newer object before an older one is collected, so each callback
      // checks the current cache entry before deleting it.
      this.signalFinalizer = new FinalizationRegistry((id) => {
        if (!this.signals.get(id)?.deref()) this.signals.delete(id);
      });
      this.modelFinalizer = new FinalizationRegistry((marker) => {
        if (!this.models.get(marker)?.deref()) this.forgetModel(marker);
      });
    }
  }

  /** Clear all cached client state. Prefer prepareReconnect() for reconnects. */
  reset() {
    this.clearPendingWatchTraffic();
    this.signals.clear();
    this.signalIds = new WeakMap();
    this.activeSignals.clear();
    this.models.clear();
    this.modelSignals.clear();
    this.refreshedRootModelMarkers.clear();
    this.staleModelMarkers.clear();
    this.refreshingModelMarkers.clear();
    this.modelRefreshGeneration++;
    this.collectingRootModels = false;
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
    this.refreshingModelMarkers.clear();
    this.modelRefreshGeneration++;
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
    this.sweepCollectedEntries();
    this.staleModelMarkers = new Set(this.models.keys());
  }

  /** Replay all currently watched signal ids on a freshly connected transport. */
  replayActiveSignals(exclude?: Iterable<SignalId>): SignalId[] {
    this.clearPendingWatchTraffic();
    return this.sendActiveSignalWatches(exclude);
  }

  private sendActiveSignalWatches(exclude?: Iterable<SignalId>): SignalId[] {
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

  /** @internal */
  beginRootSnapshot() {
    this.refreshedRootModelMarkers = new Set();
    this.collectingRootModels = true;
  }

  /** @internal */
  endRootSnapshot() {
    this.collectingRootModels = false;
  }

  /** @internal */
  getActiveHeldModelMarkers(): string[] {
    this.sweepCollectedEntries();
    return Array.from(this.models.keys()).filter(
      (marker) =>
        !this.refreshedRootModelMarkers.has(marker) &&
        !this.refreshingModelMarkers.has(marker) &&
        this.isModelMarkerActive(marker),
    );
  }

  /** @internal */
  beginModelRefresh(markers: string[]): number {
    const generation = this.modelRefreshGeneration;
    for (const marker of markers) {
      this.refreshingModelMarkers.add(marker);
    }
    return generation;
  }

  /** @internal */
  finishModelRefresh(markers: string[], generation: number): boolean {
    if (generation !== this.modelRefreshGeneration) return false;

    for (const marker of markers) {
      this.refreshingModelMarkers.delete(marker);
    }
    return true;
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

  private getSignalById(id: SignalId): Signal<any> | undefined {
    const ref = this.signals.get(id);
    if (!ref) return undefined;

    const sig = ref.deref();
    if (!sig) {
      this.signals.delete(id);
      return undefined;
    }

    return sig;
  }

  private rememberSignal(id: SignalId, sig: Signal<any>) {
    const previousId = this.signalIds.get(sig);
    if (previousId !== undefined && previousId !== id) {
      if (this.getSignalById(previousId) === sig) {
        this.signals.delete(previousId);
      }
    }

    this.signals.set(id, createCacheRef(sig));
    this.signalIds.set(sig, id);
    this.registerSignalFinalizer(id, sig);
  }

  private registerSignalFinalizer(id: SignalId, sig: Signal<any>) {
    if (!this.signalFinalizer) return;

    const previousToken = this.signalFinalizerTokens.get(sig);
    if (previousToken) this.signalFinalizer.unregister(previousToken);

    const token = {};
    this.signalFinalizerTokens.set(sig, token);
    this.signalFinalizer.register(sig, id, token);
  }

  private getModel(marker: string): RefreshableReflectedModel | undefined {
    const ref = this.models.get(marker);
    if (!ref) return undefined;

    const model = ref.deref() as RefreshableReflectedModel | undefined;
    if (!model) {
      this.forgetModel(marker);
      return undefined;
    }

    return model;
  }

  private rememberModel(marker: string, model: RefreshableReflectedModel) {
    this.models.set(marker, createCacheRef(model));
    this.registerModelFinalizer(marker, model);
  }

  private registerModelFinalizer(
    marker: string,
    model: RefreshableReflectedModel,
  ) {
    if (
      !this.modelFinalizer ||
      model === null ||
      (typeof model !== 'object' && typeof model !== 'function')
    ) {
      return;
    }

    const previousToken = this.modelFinalizerTokens.get(model);
    if (previousToken) this.modelFinalizer.unregister(previousToken);

    const token = {};
    this.modelFinalizerTokens.set(model, token);
    this.modelFinalizer.register(model, marker, token);
  }

  private forgetModel(marker: string) {
    this.models.delete(marker);
    this.modelSignals.delete(marker);
    this.refreshedRootModelMarkers.delete(marker);
    this.staleModelMarkers.delete(marker);
    this.refreshingModelMarkers.delete(marker);
  }

  private liveModelSignals(marker: string): Signal<any>[] {
    const refs = this.modelSignals.get(marker);
    if (!refs) return [];

    const signals: Signal<any>[] = [];
    for (const ref of refs) {
      const sig = ref.deref();
      if (sig) {
        signals.push(sig);
      } else {
        refs.delete(ref);
      }
    }
    return signals;
  }

  /** @internal */
  sweepCollectedEntries() {
    for (const id of this.signals.keys()) {
      this.getSignalById(id);
    }

    for (const marker of this.models.keys()) {
      this.getModel(marker);
    }

    for (const marker of this.modelSignals.keys()) {
      if (!this.models.has(marker)) {
        this.modelSignals.delete(marker);
      } else {
        this.liveModelSignals(marker);
      }
    }
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
    const existingSignal = this.getSignalById(id);
    if (existingSignal) return existingSignal;

    let createdSignal!: Signal<any>;

    createdSignal = signal(initialValue, {
      watched: () => {
        this.activeSignals.add(createdSignal);
        this.refreshStaleModelsForSignal(createdSignal);
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
    return this.rebindSignal(previousSignal, nextSignal, true);
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

  private isModelMarkerActive(marker: string): boolean {
    for (const sig of this.liveModelSignals(marker)) {
      if (this.activeSignals.has(sig)) return true;
    }
    return false;
  }

  private collectModelSignals(data: Record<string, any>): Set<Signal<any>> {
    const signals = new Set<Signal<any>>();
    for (const value of Object.values(data)) {
      if (value instanceof SignalCtor) signals.add(value);
    }
    return signals;
  }

  private rememberModelSignals(
    marker: string,
    model: RefreshableReflectedModel,
    data: Record<string, any>,
    hasModelData = true,
  ) {
    const signals = model[GET_REFLECTED_MODEL_SIGNALS]?.();
    if (signals) {
      this.modelSignals.set(marker, this.createSignalRefs(signals));
    } else if (hasModelData) {
      this.modelSignals.set(
        marker,
        this.createSignalRefs(this.collectModelSignals(data)),
      );
    }
  }

  private createSignalRefs(
    signals: Iterable<Signal<any>>,
  ): Set<CacheRef<Signal<any>>> {
    return new Set(Array.from(signals, (sig) => createCacheRef(sig)));
  }

  private modelHasLiveSignal(marker: string, target: Signal<any>): boolean {
    const refs = this.modelSignals.get(marker);
    if (!refs) return false;

    let found = false;
    for (const ref of refs) {
      const sig = ref.deref();
      if (sig) {
        if (sig === target) found = true;
      } else {
        refs.delete(ref);
      }
    }

    return found;
  }

  private refreshStaleModelsForSignal(sig: Signal<any>) {
    const markers: string[] = [];
    for (const marker of this.staleModelMarkers) {
      if (
        !this.refreshingModelMarkers.has(marker) &&
        this.getModel(marker) &&
        this.modelHasLiveSignal(marker, sig)
      ) {
        markers.push(marker);
      }
    }

    if (markers.length === 0) return;

    const generation = this.beginModelRefresh(markers);

    void this.rpc
      .call(REFRESH_MODELS_METHOD, markers)
      .catch(() => undefined)
      .finally(() => {
        if (this.finishModelRefresh(markers, generation)) {
          this.sendActiveSignalWatches();
        }
      });
  }

  private markModelFresh(marker: string) {
    this.staleModelMarkers.delete(marker);
  }

  private rebindSignal(
    previousSignal: Signal<any>,
    nextSignal: Signal<any>,
    preferExisting = false,
  ): Signal<any> {
    const nextId = this.signalIds.get(nextSignal);
    if (nextId !== undefined) {
      const existingSignal = this.getSignalById(nextId);
      if (
        preferExisting &&
        existingSignal &&
        existingSignal !== previousSignal
      ) {
        this.transferSignalState(previousSignal, existingSignal);
        this.transferSignalState(nextSignal, existingSignal);
        previousSignal.value = existingSignal.peek();
        return existingSignal;
      }

      this.rememberSignal(nextId, previousSignal);
    }

    this.transferSignalState(nextSignal, previousSignal);

    previousSignal.value = nextSignal.peek();
    return previousSignal;
  }

  private transferSignalState(from: Signal<any>, to: Signal<any>) {
    if (from === to) return;

    if (this.activeSignals.has(from)) {
      this.activeSignals.delete(from);
      this.activeSignals.add(to);
    }

    if (this.watchedSignals.has(from)) {
      this.watchedSignals.delete(from);
      this.watchedSignals.add(to);
    }

    if (this.watchBatch.delete(from)) this.watchBatch.add(to);
    if (this.unwatchBatch.delete(from)) this.unwatchBatch.add(to);
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
    const hasModelData = Object.keys(serialized).some((key) => key !== '@M');
    if (this.collectingRootModels && hasModelData) {
      this.refreshedRootModelMarkers.add(raw);
    }

    const existing = this.getModel(raw);
    if (existing) {
      existing[REFRESH_REFLECTED_MODEL]?.(data);
      this.rememberModelSignals(raw, existing, data, hasModelData);
      if (hasModelData) this.markModelFresh(raw);
      return existing;
    }

    const ModelCtor = this.modelRegistry.get(typeName);
    if (!ModelCtor) {
      throw new Error(`Unknown model type: ${typeName}`);
    }

    const model = new ModelCtor(this.ctx, data);
    this.rememberModel(raw, model);
    this.rememberModelSignals(raw, model, data, hasModelData);
    if (hasModelData) this.markModelFresh(raw);
    return model;
  }

  handleUpdate(id: SignalId, value: any, mode?: string) {
    const sig = this.getSignalById(id);
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
