import {type Signal, signal} from '@preact/signals-core';
import {
  UNWATCH_SIGNALS_METHOD,
  WATCH_SIGNALS_METHOD,
} from '../shared/protocol.ts';
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
