import {signal} from '@preact/signals-core';
import {describe, expect, it} from 'vitest';
import {createModel} from '../../server/model.ts';
import {MODEL_NAME_SYMBOL} from '../../shared/serialize.ts';

describe('createModel', () => {
  it('returns a constructor function', () => {
    const Model = createModel('V', () => ({value: signal(0)}));
    expect(typeof Model).toBe('function');
  });

  it('requires a name', () => {
    expect(() =>
      (createModel as any)(null, () => ({value: signal(0)})),
    ).toThrow();
    expect(() =>
      (createModel as any)('', () => ({value: signal(0)})),
    ).toThrow();
  });

  it('stamps the name on the ctor for serializer lookup', () => {
    const Model = createModel('Widget', () => ({value: signal(0)}));
    expect((Model as any)[MODEL_NAME_SYMBOL]).toBe('Widget');
  });

  it('instances pass instanceof check', () => {
    const Model = createModel('M', () => ({value: signal(0)}));
    const instance = new Model();
    expect(instance).toBeInstanceOf(Model);
  });

  it('factory receives constructor arguments', () => {
    const Model = createModel<
      {val: ReturnType<typeof signal<number>>},
      [initial: number]
    >('VAL', (initial) => ({
      val: signal(initial),
    }));
    const instance = new Model(42);
    expect(instance.val.peek()).toBe(42);
  });

  it('model properties are accessible on instance', () => {
    const Model = createModel('M', () => {
      const count = signal(10);
      return {
        count,
        greet() {
          return 'hello';
        },
      };
    });
    const instance = new Model();
    expect(instance.count.peek()).toBe(10);
    expect(instance.greet()).toBe('hello');
  });

  it('different instances are independent', () => {
    const Model = createModel('M', () => ({count: signal(0)}));
    const a = new Model();
    const b = new Model();
    a.count.value = 5;
    expect(a.count.peek()).toBe(5);
    expect(b.count.peek()).toBe(0);
  });
});
