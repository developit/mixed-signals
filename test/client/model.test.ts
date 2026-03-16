import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {type Signal, signal} from '@preact/signals-core';
import {createReflectedModel} from '../../client/model.ts';

describe('createReflectedModel', () => {
  function createCtx() {
    const calls: {method: string; params: any[]}[] = [];
    return {
      rpc: {
        async call(method: string, params?: any[]) {
          calls.push({method, params: params || []});
          return `result:${method}`;
        },
      },
      calls,
    };
  }

  it('exposes id signal with wireId value', () => {
    const Model = createReflectedModel<{
      id: Signal<string>;
    }>([], []);
    const {rpc} = createCtx();

    const instance = new Model({rpc}, {'@wireId': 'abc-123'});
    assert.equal(instance.id.peek(), 'abc-123');
  });

  it('creates computed signal properties from server signals', () => {
    const Model = createReflectedModel<{
      id: Signal<string>;
      count: Signal<number>;
      name: Signal<string>;
    }>(['count', 'name'], []);
    const {rpc} = createCtx();

    const countSig = signal(42);
    const nameSig = signal('test');

    const instance = new Model(
      {rpc},
      {'@wireId': '1', count: countSig, name: nameSig},
    );
    assert.equal(instance.count.peek(), 42);
    assert.equal(instance.name.peek(), 'test');
  });

  it('computed props update when source signals change', () => {
    const Model = createReflectedModel<{
      id: Signal<string>;
      count: Signal<number>;
    }>(['count'], []);
    const {rpc} = createCtx();

    const countSig = signal(0);
    const instance = new Model({rpc}, {'@wireId': '1', count: countSig});

    assert.equal(instance.count.peek(), 0);
    countSig.value = 99;
    assert.equal(instance.count.peek(), 99);
  });

  it('creates method proxies that call rpc.call with wireId#method', async () => {
    const Model = createReflectedModel<{
      id: Signal<string>;
      increment(): Promise<any>;
      rename(name: string): Promise<any>;
    }>([], ['increment', 'rename']);
    const ctx = createCtx();

    const instance = new Model({rpc: ctx.rpc}, {'@wireId': 'w7'});

    await instance.increment();
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0].method, 'w7#increment');
    assert.deepEqual(ctx.calls[0].params, []);

    await instance.rename('new-name');
    assert.equal(ctx.calls.length, 2);
    assert.equal(ctx.calls[1].method, 'w7#rename');
    assert.deepEqual(ctx.calls[1].params, ['new-name']);
  });

  it('method proxies return rpc call result', async () => {
    const Model = createReflectedModel<{
      id: Signal<string>;
      getData(): Promise<any>;
    }>([], ['getData']);
    const ctx = createCtx();

    const instance = new Model({rpc: ctx.rpc}, {'@wireId': 'w1'});
    const result = await instance.getData();
    assert.equal(result, 'result:w1#getData');
  });

  it('skips signal props not present in data', () => {
    const Model = createReflectedModel<{
      id: Signal<string>;
      missing: Signal<any>;
    }>(['missing'], []);
    const {rpc} = createCtx();

    const instance = new Model({rpc}, {'@wireId': '1'});
    // missing prop should not exist since data didn't have it
    assert.equal(instance.missing, undefined);
  });
});
