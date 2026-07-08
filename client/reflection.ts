import {type Signal, signal} from '@preact/signals-core';
import {
  UNWATCH_SIGNALS_METHOD,
  WATCH_SIGNALS_METHOD,
} from '../shared/protocol.ts';
import type {RPCClient} from './rpc.ts';

type SignalId = number | string;

const WATCH_FLUSH_DELAY = 10;

/** @internal */
export interface WireContext {
  rpc: RPCClient;
}

export class ClientReflection {
  private signals = new Map<SignalId, Signal<any>>();
  private models = new Map<string, any>();
  private modelRegistry = new Map<string, any>();
  private rpc: RPCClient;
  private ctx: WireContext;
  private static queuedWatchFlushes = new Set<ClientReflection>();
  private static watchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static flushingWatches = false;

  private watchedSignals = new Set<SignalId>();
  private watchBatch = new Map<SignalId, number>();
  private unwatchBatch = new Map<SignalId, number>();

  constructor(rpc: RPCClient, ctx?: any) {
    this.rpc = rpc;
    this.ctx = ctx && ctx.rpc === rpc ? ctx : {rpc};
  }

  /** Clear cached signals and model facades so a reconnection gets fresh state. */
  reset() {
    this.signals.clear();
    this.models.clear();
    this.watchedSignals.clear();
    this.watchBatch.clear();
    this.unwatchBatch.clear();
    ClientReflection.queuedWatchFlushes.delete(this);
    if (
      ClientReflection.queuedWatchFlushes.size === 0 &&
      ClientReflection.watchFlushTimer
    ) {
      clearTimeout(ClientReflection.watchFlushTimer);
      ClientReflection.watchFlushTimer = null;
    }
  }

  registerModel(typeName: string, ctor: any) {
    this.modelRegistry.set(typeName, ctor);
  }

  private static queueGlobalWatchFlush(delay = WATCH_FLUSH_DELAY) {
    if (ClientReflection.watchFlushTimer || ClientReflection.flushingWatches) {
      return;
    }

    ClientReflection.watchFlushTimer = setTimeout(() => {
      ClientReflection.watchFlushTimer = null;
      ClientReflection.flushQueuedWatches();
    }, delay);
  }

  private static flushQueuedWatches() {
    const now = Date.now();
    ClientReflection.flushingWatches = true;

    try {
      for (const reflection of Array.from(
        ClientReflection.queuedWatchFlushes,
      )) {
        reflection.flushWatches(now);
      }
    } finally {
      ClientReflection.flushingWatches = false;
    }

    const nextFlush = ClientReflection.nextQueuedWatchFlush(now);
    if (nextFlush !== undefined) {
      ClientReflection.queueGlobalWatchFlush(nextFlush);
    }
  }

  private static nextQueuedWatchFlush(now: number): number | undefined {
    let nextFlush: number | undefined;

    for (const reflection of ClientReflection.queuedWatchFlushes) {
      const reflectionNextFlush = reflection.nextWatchFlush(now);

      if (reflectionNextFlush === undefined) {
        ClientReflection.queuedWatchFlushes.delete(reflection);
      } else {
        nextFlush = Math.min(
          nextFlush ?? reflectionNextFlush,
          reflectionNextFlush,
        );
      }
    }

    return nextFlush;
  }

  private queueWatchFlush() {
    ClientReflection.queuedWatchFlushes.add(this);
    ClientReflection.queueGlobalWatchFlush();
  }

  private scheduleWatch(id: SignalId) {
    this.unwatchBatch.delete(id);

    if (!this.watchedSignals.has(id)) {
      this.watchBatch.set(id, Date.now() + WATCH_FLUSH_DELAY);
      this.queueWatchFlush();
    }
  }

  private scheduleUnwatch(id: SignalId) {
    this.watchBatch.delete(id);

    if (this.watchedSignals.has(id)) {
      this.unwatchBatch.set(id, Date.now() + WATCH_FLUSH_DELAY);
      this.queueWatchFlush();
    }
  }

  private flushWatches(now: number) {
    const watchIds = this.takeDue(this.watchBatch, now);
    const unwatchIds = this.takeDue(this.unwatchBatch, now);

    if (watchIds.length > 0) {
      for (const id of watchIds) this.watchedSignals.add(id);
      this.rpc.notify(WATCH_SIGNALS_METHOD, watchIds);
    }

    if (unwatchIds.length > 0) {
      for (const id of unwatchIds) this.watchedSignals.delete(id);
      this.rpc.notify(UNWATCH_SIGNALS_METHOD, unwatchIds);
    }
  }

  private takeDue(batch: Map<SignalId, number>, now: number): SignalId[] {
    const ids: SignalId[] = [];

    for (const [id, flushAt] of batch) {
      if (flushAt <= now) {
        batch.delete(id);
        ids.push(id);
      }
    }

    return ids;
  }

  private nextWatchFlush(now: number): number | undefined {
    let flushAt: number | undefined;

    for (const time of this.watchBatch.values()) {
      flushAt = Math.min(flushAt ?? time, time);
    }

    for (const time of this.unwatchBatch.values()) {
      flushAt = Math.min(flushAt ?? time, time);
    }

    return flushAt === undefined ? undefined : Math.max(0, flushAt - now);
  }

  getOrCreateSignal(id: SignalId, initialValue: any): Signal<any> {
    const existingSignal = this.signals.get(id);
    if (existingSignal) return existingSignal;

    const createdSignal = signal(initialValue, {
      watched: () => {
        // Only tell the server once the client actually observes this signal.
        this.scheduleWatch(id);
      },
      unwatched: () => {
        // Debounce unwatch so transient unmount/remount cycles stay subscribed.
        this.scheduleUnwatch(id);
      },
    });

    this.signals.set(id, createdSignal);
    return createdSignal;
  }

  createModelFacade(serialized: any): any {
    const raw: string = serialized['@M'];
    if (!raw) {
      throw new Error('Model missing @M field');
    }

    const existing = this.models.get(raw);
    if (existing) {
      return existing;
    }

    // Models are branded as TypeName#wireId so the facade knows both pieces.
    const hashIdx = raw.lastIndexOf('#');
    const typeName = hashIdx !== -1 ? raw.slice(0, hashIdx) : raw;
    const wireId = hashIdx !== -1 ? raw.slice(hashIdx + 1) : undefined;

    const ModelCtor = this.modelRegistry.get(typeName);
    if (!ModelCtor) {
      throw new Error(`Unknown model type: ${typeName}`);
    }

    const model = new ModelCtor(this.ctx, {...serialized, '@wireId': wireId});
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
