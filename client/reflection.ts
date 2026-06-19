import {type Signal, signal} from '@preact/signals-core';
import {
  UNWATCH_SIGNALS_METHOD,
  WATCH_SIGNALS_METHOD,
} from '../shared/protocol.ts';
import {
  applyDelta,
  applyServerUpdate,
  coerceDeltaMode,
  linkSource,
} from './optimistic.ts';
import type {RPCClient} from './rpc.ts';

/** @internal */
export interface WireContext {
  rpc: RPCClient;
}

export class ClientReflection {
  private signals = new Map<number | string, Signal<any>>();
  private models = new Map<string, any>();
  private modelRegistry = new Map<string, any>();
  private rpc: RPCClient;
  private ctx: WireContext;
  private watchBatch = new Set<number | string>();
  private unwatchBatch = new Set<number | string>();
  private watchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private unwatchFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(rpc: RPCClient, ctx?: any) {
    this.rpc = rpc;
    this.ctx = ctx && ctx.rpc === rpc ? ctx : {rpc};
  }

  /** Clear cached signals and model facades so a reconnection gets fresh state. */
  reset() {
    this.signals.clear();
    this.models.clear();
    this.watchBatch.clear();
    this.unwatchBatch.clear();
    if (this.watchFlushTimer) {
      clearTimeout(this.watchFlushTimer);
      this.watchFlushTimer = null;
    }
    if (this.unwatchFlushTimer) {
      clearTimeout(this.unwatchFlushTimer);
      this.unwatchFlushTimer = null;
    }
  }

  registerModel(typeName: string, ctor: any) {
    this.modelRegistry.set(typeName, ctor);
  }

  private scheduleWatch(id: number | string) {
    // Batch watch messages so a render burst becomes one frame.
    this.watchBatch.add(id);
    if (!this.watchFlushTimer) {
      this.watchFlushTimer = setTimeout(() => {
        const ids = Array.from(this.watchBatch);
        this.watchBatch.clear();
        this.watchFlushTimer = null;
        if (ids.length > 0) {
          this.rpc.notify(WATCH_SIGNALS_METHOD, ids);
        }
      }, 1);
    }
  }

  private scheduleUnwatch(id: number | string) {
    // Unwatchs are batched separately so quick remounts can cancel them.
    this.unwatchBatch.add(id);
    if (!this.unwatchFlushTimer) {
      this.unwatchFlushTimer = setTimeout(() => {
        const ids = Array.from(this.unwatchBatch);
        this.unwatchBatch.clear();
        this.unwatchFlushTimer = null;
        if (ids.length > 0) {
          this.rpc.notify(UNWATCH_SIGNALS_METHOD, ids);
        }
      }, 1);
    }
  }

  getOrCreateSignal(id: number | string, initialValue: any): Signal<any> {
    const existingSignal = this.signals.get(id);
    if (existingSignal) return existingSignal;

    let unwatchTimeout: ReturnType<typeof setTimeout> | null = null;

    const createdSignal = signal(initialValue, {
      watched: () => {
        if (unwatchTimeout) {
          clearTimeout(unwatchTimeout);
          unwatchTimeout = null;
        } else {
          // Only tell the server once the client actually observes this signal.
          this.scheduleWatch(id);
        }
      },
      unwatched: () => {
        // Debounce unwatch so transient unmount/remount cycles stay subscribed.
        unwatchTimeout = setTimeout(() => {
          this.scheduleUnwatch(id);
          unwatchTimeout = null;
        }, 10);
      },
    });

    linkSource(createdSignal, createdSignal);
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

  handleUpdate(id: number | string, value: any, mode?: string) {
    const sig = this.signals.get(id);
    if (!sig) return;

    const delta = coerceDeltaMode(mode);
    if (applyServerUpdate(sig, value, delta)) return;

    sig.value = applyDelta(sig.peek(), value, delta);
  }
}
