import type {Signal} from '@preact/signals-core';
import {signal} from '@preact/signals-core';

export interface WireContext {
  rpc: {call(method: string, params?: unknown[]): Promise<unknown>};
}

export class ClientReflection {
  private signals = new Map<number, Signal<any>>();
  private modelRegistry = new Map<string, any>();
  private modelCache = new Map<string, any>();
  private rpc: any;
  private ctx: WireContext;
  private watchBatch = new Set<number>();
  private unwatchBatch = new Set<number>();
  private watchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private unwatchFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(rpc: any, ctx: WireContext) {
    this.rpc = rpc;
    this.ctx = ctx;
  }

  registerModel(typeName: string, ctor: any) {
    this.modelRegistry.set(typeName, ctor);
  }

  private scheduleWatch(id: number) {
    this.watchBatch.add(id);
    if (!this.watchFlushTimer) {
      this.watchFlushTimer = setTimeout(() => {
        const ids = Array.from(this.watchBatch);
        this.watchBatch.clear();
        this.watchFlushTimer = null;
        if (ids.length > 0) {
          this.rpc.notify('@W', ids);
        }
      }, 1);
    }
  }

  private scheduleUnwatch(id: number) {
    this.unwatchBatch.add(id);
    if (!this.unwatchFlushTimer) {
      this.unwatchFlushTimer = setTimeout(() => {
        const ids = Array.from(this.unwatchBatch);
        this.unwatchBatch.clear();
        this.unwatchFlushTimer = null;
        if (ids.length > 0) {
          this.rpc.notify('@U', ids);
        }
      }, 1);
    }
  }

  getOrCreateSignal(id: number, initialValue: any): Signal<any> {
    if (!this.signals.has(id)) {
      let unwatchTimeout: ReturnType<typeof setTimeout> | null = null;

      const sig = signal(initialValue, {
        watched: () => {
          // Cancel pending unwatch if re-subscribing
          if (unwatchTimeout) {
            clearTimeout(unwatchTimeout);
            unwatchTimeout = null;
          } else {
            // First subscriber - tell server to send updates (batched)
            this.scheduleWatch(id);
          }
        },
        unwatched: () => {
          // Debounce unwatch to prevent rapid unsub/resub loops
          unwatchTimeout = setTimeout(() => {
            this.scheduleUnwatch(id);
            unwatchTimeout = null;
          }, 10);
        },
      });

      this.signals.set(id, sig);
    }

    return this.signals.get(id)!;
  }

  createModelFacade(serialized: any): any {
    const raw: string = serialized['@M'];
    if (!raw) {
      throw new Error('Model missing @M field');
    }

    // Always return the same facade for a given model identity.
    // Signals inside are shared references (via getOrCreateSignal),
    // so the data stays in sync automatically.
    const cached = this.modelCache.get(raw);
    if (cached) return cached;

    // Combined @M field: "TypeName#wireId"
    const hashIdx = raw.lastIndexOf('#');
    const typeName = hashIdx !== -1 ? raw.slice(0, hashIdx) : raw;
    const wireId = hashIdx !== -1 ? raw.slice(hashIdx + 1) : undefined;

    const ModelCtor = this.modelRegistry.get(typeName);
    if (!ModelCtor) {
      throw new Error(`Unknown model type: ${typeName}`);
    }

    serialized['@wireId'] = wireId;
    const facade = new ModelCtor(this.ctx, serialized);
    this.modelCache.set(raw, facade);
    return facade;
  }

  handleUpdate(id: number, value: any, mode?: string) {
    const sig = this.signals.get(id);
    if (!sig) return;

    if (!mode) {
      sig.value = value;
      return;
    }

    const current = sig.value;

    switch (mode) {
      case 'append':
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
        if (Array.isArray(current)) {
          const {start, deleteCount, items} = value;
          const newArray = [...current];
          newArray.splice(start, deleteCount, ...items);
          sig.value = newArray;
        }
        break;

      default:
        sig.value = value;
    }
  }
}
