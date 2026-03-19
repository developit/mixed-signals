import {computed, createModel, Signal, signal} from '@preact/signals-core';
import type {WireContext} from './reflection.ts';

export function createReflectedModel<T>(
  signalProps: string[],
  methods: string[],
) {
  return createModel<T, [ctx: WireContext, data: any]>((ctx, data) => {
    const model: any = {};
    const wireId: string = data['@wireId'];

    // Preserve the server-side wire identity for keys and instance calls.
    model.id = signal(wireId);

    for (const prop of signalProps) {
      if (data?.[prop] instanceof Signal) {
        model[prop] = computed(() => data[prop].value);
      }
    }

    for (const method of methods) {
      model[method] = async (...args: any[]) => {
        return ctx.rpc.call(`${wireId}#${method}`, args);
      };
    }

    return model;
  });
}
