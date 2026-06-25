import {computed, createModel, Signal, signal} from '@preact/signals-core';
import type {WireContext} from './reflection.ts';

/** @internal */
export const REFRESH_REFLECTED_MODEL = Symbol('mixed-signals.refreshModel');

/** @internal */
export interface RefreshableReflectedModel {
  [REFRESH_REFLECTED_MODEL]?(data: any): void;
}

export function createReflectedModel<T>(
  signalProps: string[],
  methods: string[],
) {
  return createModel<T, [ctx: WireContext, data: any]>((ctx, data) => {
    const model: any = {};
    const wireId = signal(String(data['@wireId']));
    const signalSources = new Map<string, Signal<Signal<any>>>();

    // Preserve the server-side wire identity for keys and instance calls.
    model.id = signal(wireId.peek());

    for (const prop of signalProps) {
      if (data?.[prop] instanceof Signal) {
        const source = signal(data[prop] as Signal<any>);
        signalSources.set(prop, source);
        model[prop] = computed(() => source.value.value);
      }
    }

    for (const method of methods) {
      model[method] = async (...args: any[]) => {
        return ctx.rpc.call(`${wireId.peek()}#${method}`, args);
      };
    }

    Object.defineProperty(model, REFRESH_REFLECTED_MODEL, {
      enumerable: false,
      value(nextData: any) {
        const nextWireId = String(nextData['@wireId']);
        if (wireId.peek() !== nextWireId) {
          wireId.value = nextWireId;
          if (!signalSources.has('id') && model.id instanceof Signal) {
            model.id.value = nextWireId;
          }
        }

        for (const prop of signalProps) {
          const nextSignal = nextData?.[prop];
          if (!(nextSignal instanceof Signal)) continue;

          const existingSource = signalSources.get(prop);
          if (existingSource) {
            existingSource.value = ctx.rpc.syncSignalIdentity(
              existingSource.peek(),
              nextSignal,
            );
          } else {
            const source = signal(nextSignal as Signal<any>);
            signalSources.set(prop, source);
            model[prop] = computed(() => source.value.value);
          }
        }
      },
    });

    return model;
  });
}
