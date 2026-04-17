import type {ModelConstructor, ModelFactory} from '@preact/signals-core';
import {createModel as originalCreateModel} from '@preact/signals-core';
import {MODEL_NAME_SYMBOL} from '../shared/serialize.ts';
import '../shared/disposable.ts';

/**
 * Create a server-side Model with a stable wire name. The name crosses the
 * wire once per client and is used on the receiving side to expose the
 * type (e.g. for `instanceof`-like checks and logging).
 *
 * The name is stamped onto the resulting constructor via a registered symbol,
 * which lets the serializer identify "named objects" (Models) vs anonymous
 * plain objects without a central registry on either side.
 */
export function createModel<TModel, TFactoryArgs extends any[] = []>(
  name: string,
  factory: ModelFactory<TModel, TFactoryArgs>,
): ModelConstructor<TModel, TFactoryArgs> {
  if (!name || typeof name !== 'string') {
    throw new Error('createModel: name is required');
  }
  const Ctor = originalCreateModel<TModel, TFactoryArgs>(((
    ...args: TFactoryArgs
  ) => {
    const model = factory(...args);
    Object.setPrototypeOf(model, Ctor.prototype);
    return model;
  }) as ModelFactory<TModel, TFactoryArgs>);
  Object.defineProperty(Ctor, MODEL_NAME_SYMBOL, {
    value: name,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return Ctor;
}
