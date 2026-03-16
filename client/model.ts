import {computed, createModel, Signal, signal} from '@preact/signals-core';
import type {WireContext} from './reflection';
import '../shared/disposable';

// Creates a Preact Model constructor for reflected server models.
// Every reflected model is an instance with a wire ID from the combined @M field.
export function createReflectedModel<T>(
  signalProps: string[],
  methods: string[],
) {
  return createModel<T, [ctx: WireContext, data: any]>((ctx, data) => {
    const model: any = {};
    const wireId: string = data['@wireId'];

    // Always expose wire ID as a read-only signal
    model.id = signal(wireId);

    // Create computeds for signal properties
    for (const prop of signalProps) {
      if (data?.[prop] instanceof Signal) {
        model[prop] = computed(() => data[prop].value);
      }
    }

    // Create method proxies — all route as wireId#method
    for (const method of methods) {
      model[method] = async (...args: any[]) => {
        return ctx.rpc.call(`${wireId}#${method}`, args);
      };
    }

    return model;
  });
}
