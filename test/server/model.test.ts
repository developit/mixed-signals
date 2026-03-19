import {signal} from '@preact/signals-core';
import {describe, expect, it} from 'vitest';
import {createModel} from '../../server/model.ts';

describe('createModel', () => {
  it('returns a constructor function', () => {
    const Model = createModel(() => ({value: signal(0)}));
    expect(typeof Model).toBe('function');
  });

  it('instances pass instanceof check', () => {
    const Model = createModel(() => ({value: signal(0)}));
    const instance = new Model();
    expect(instance).toBeInstanceOf(Model);
  });

  it('factory receives constructor arguments', () => {
    const Model = createModel<
      {val: ReturnType<typeof signal<number>>},
      [initial: number]
    >((initial) => ({
      val: signal(initial),
    }));
    const instance = new Model(42);
    expect(instance.val.peek()).toBe(42);
  });

  it('model properties are accessible on instance', () => {
    const Model = createModel(() => {
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
    const Model = createModel(() => ({count: signal(0)}));
    const a = new Model();
    const b = new Model();
    a.count.value = 5;
    expect(a.count.peek()).toBe(5);
    expect(b.count.peek()).toBe(0);
  });
});
