import {computed, createModel, Signal, signal} from '@preact/signals-core';
import type {WireContext} from './reflection.ts';

export function createReflectedModel<T>(
  signalProps: string[],
  methods: string[],
  path?: string,
) {
  return createModel<T, [ctx: WireContext, data: any]>((ctx, data) => {
    const model: any = {};
    const wireId: string = data['@wireId'];
    // Collection-style models can receive Signal props later via method results.
    const signalHolders = new Map<string, Signal<Signal<any> | null>>();

    // Preserve the server-side wire identity for keys and instance calls.
    model.id = signal(wireId);

    for (const prop of signalProps) {
      if (data?.[prop] instanceof Signal) {
        model[prop] = computed(() => data[prop].value);
        continue;
      }

      const holder = signal<Signal<any> | null>(null);
      signalHolders.set(prop, holder);
      model[prop] = computed(() => holder.value?.value);
    }

    // Stitch returned Signal props into the computed holders above.
    const updateSignalHolders = (value: unknown) => {
      if (!value || typeof value !== 'object') return;

      for (const prop of signalProps) {
        const holder = signalHolders.get(prop);
        const nextSignal = (value as Record<string, unknown>)[prop];
        if (holder && nextSignal instanceof Signal) {
          holder.value = nextSignal;
        }
      }
    };

    for (const method of methods) {
      model[method] = async (...args: any[]) => {
        // Collection models route via path.method; instances route via wireId#method.
        const route = path ? `${path}.${method}` : `${wireId}#${method}`;
        const result = await ctx.rpc.call(route, args);
        updateSignalHolders(result);
        return result;
      };
    }

    return model;
  });
}
