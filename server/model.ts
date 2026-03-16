import type {ModelConstructor, ModelFactory} from '@preact/signals-core';
import {createModel as originalCreateModel} from '@preact/signals-core';

export function createModel<TModel, TFactoryArgs extends any[] = []>(
  factory: ModelFactory<TModel, TFactoryArgs>,
): ModelConstructor<TModel, TFactoryArgs> {
  const Ctor = originalCreateModel<TModel, TFactoryArgs>(((
    ...args: TFactoryArgs
  ) => {
    const model = factory(...args);
    Object.setPrototypeOf(model, Ctor.prototype);
    return model;
  }) as ModelFactory<TModel, TFactoryArgs>);
  return Ctor;
}
