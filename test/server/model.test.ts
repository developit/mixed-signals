import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {signal} from '@preact/signals-core';
import {createModel} from '../../server/model.ts';

describe('createModel', () => {
  it('returns a constructor function', () => {
    const Model = createModel(() => ({value: signal(0)}));
    assert.equal(typeof Model, 'function');
  });

  it('instances pass instanceof check', () => {
    const Model = createModel(() => ({value: signal(0)}));
    const instance = new Model();
    assert.ok(instance instanceof Model);
  });

  it('factory receives constructor arguments', () => {
    const Model = createModel<
      {val: ReturnType<typeof signal<number>>},
      [initial: number]
    >((initial) => ({
      val: signal(initial),
    }));
    const instance = new Model(42);
    assert.equal(instance.val.peek(), 42);
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
    assert.equal(instance.count.peek(), 10);
    assert.equal(instance.greet(), 'hello');
  });

  it('different instances are independent', () => {
    const Model = createModel(() => ({count: signal(0)}));
    const a = new Model();
    const b = new Model();
    a.count.value = 5;
    assert.equal(a.count.peek(), 5);
    assert.equal(b.count.peek(), 0);
  });
});
