import {
  computed,
  createModel,
  type ReadonlySignal,
  Signal,
  signal,
} from '@preact/signals-core';
import {linkSource, type ReflectedSignal} from './optimistic.ts';
import type {WireContext} from './reflection.ts';

type SignalKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends ReadonlySignal<unknown> ? K : never;
}[keyof T];

type MethodKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof T];

type ReflectedFacade<T> = {
  [K in keyof T]: NonNullable<T[K]> extends ReadonlySignal<infer V>
    ? ReflectedSignal<V>
    : NonNullable<T[K]> extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Awaited<R>>
      : T[K];
};

export function createReflectedModel<T>(
  signalProps: ReadonlyArray<SignalKeys<T>>,
  methods: ReadonlyArray<MethodKeys<T>>,
) {
  return createModel<ReflectedFacade<T>, [ctx: WireContext, data: any]>(
    (ctx, data) => {
      const model: any = {};
      const wireId: string = data['@wireId'];

      const idSignal = signal(wireId);
      model.id = linkSource(idSignal, idSignal);

      for (const prop of signalProps) {
        const source = data?.[prop];
        if (source instanceof Signal) {
          model[prop] = linkSource(
            computed(() => source.value),
            source,
          );
        }
      }

      for (const method of methods) {
        model[method] = async (...args: any[]) =>
          ctx.rpc.call(`${wireId}#${String(method)}`, args);
      }

      return model;
    },
  );
}
