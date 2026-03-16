import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {effect} from '@preact/signals-core';
import {ClientReflection} from '../../client/reflection.ts';
import {flush, ReflectedCounter} from '../helpers.ts';

describe('ClientReflection', () => {
  let notifyCalls: {method: string; params: any[]}[];
  let mockRpc: any;
  let ctx: any;
  let reflection: ClientReflection;

  beforeEach(() => {
    notifyCalls = [];
    mockRpc = {
      notify(method: string, params: any[]) {
        notifyCalls.push({method, params});
      },
      call: async () => undefined,
    };
    ctx = {rpc: mockRpc};
    reflection = new ClientReflection(mockRpc, ctx);
  });

  describe('getOrCreateSignal', () => {
    it('creates signal with initial value', () => {
      const sig = reflection.getOrCreateSignal(1, 42);
      assert.equal(sig.peek(), 42);
    });

    it('returns cached signal for same id', () => {
      const sig1 = reflection.getOrCreateSignal(1, 'first');
      const sig2 = reflection.getOrCreateSignal(1, 'ignored');
      assert.equal(sig1, sig2);
      assert.equal(sig1.peek(), 'first');
    });

    it('different ids get different signals', () => {
      const sig1 = reflection.getOrCreateSignal(1, 'a');
      const sig2 = reflection.getOrCreateSignal(2, 'b');
      assert.notEqual(sig1, sig2);
    });
  });

  describe('watch/unwatch batching', () => {
    it('schedules @W notification when signal is watched', async () => {
      const sig = reflection.getOrCreateSignal(1, 'val');

      // Subscribe to trigger watched callback
      const dispose = effect(() => {
        sig.value;
      });

      await flush();
      const watchCall = notifyCalls.find((c) => c.method === '@W');
      assert.ok(
        watchCall,
        `Expected @W call, got: ${JSON.stringify(notifyCalls)}`,
      );
      assert.deepEqual(watchCall!.params, [1]);

      dispose();
    });

    it('batches multiple watch requests into single message', async () => {
      const sig1 = reflection.getOrCreateSignal(1, 'a');
      const sig2 = reflection.getOrCreateSignal(2, 'b');
      const sig3 = reflection.getOrCreateSignal(3, 'c');

      const dispose = effect(() => {
        sig1.value;
        sig2.value;
        sig3.value;
      });

      await flush();
      const watchCalls = notifyCalls.filter((c) => c.method === '@W');
      assert.equal(watchCalls.length, 1); // single batched call
      assert.deepEqual(watchCalls[0].params, [1, 2, 3]);

      dispose();
    });

    it('schedules @U after unwatch debounce timeout', async () => {
      const sig = reflection.getOrCreateSignal(1, 'val');

      const dispose = effect(() => {
        sig.value;
      });

      await flush();
      notifyCalls.length = 0;

      dispose(); // triggers unwatched

      await flush(50); // wait for 10ms debounce
      const unwatchCall = notifyCalls.find((c) => c.method === '@U');
      assert.ok(
        unwatchCall,
        `Expected @U call, got: ${JSON.stringify(notifyCalls)}`,
      );
      assert.deepEqual(unwatchCall!.params, [1]);
    });

    it('cancels pending unwatch if re-subscribed quickly', async () => {
      const sig = reflection.getOrCreateSignal(1, 'val');

      const dispose1 = effect(() => {
        sig.value;
      });
      await flush();
      notifyCalls.length = 0;

      // Unsubscribe
      dispose1();

      // Re-subscribe within the 10ms debounce window
      const dispose2 = effect(() => {
        sig.value;
      });

      await flush(50);
      const unwatchCalls = notifyCalls.filter((c) => c.method === '@U');
      assert.equal(unwatchCalls.length, 0, 'Should not have sent @U');

      dispose2();
    });
  });

  describe('createModelFacade', () => {
    it('creates facade from serialized data with @M marker', () => {
      reflection.registerModel('Counter', ReflectedCounter);

      const sig = reflection.getOrCreateSignal(10, 0);
      const facade = reflection.createModelFacade({
        '@M': 'Counter#abc',
        count: sig,
      });
      assert.ok(facade);
      assert.equal(facade.id.peek(), 'abc');
    });

    it('throws on missing @M field', () => {
      assert.throws(() => {
        reflection.createModelFacade({});
      }, /Model missing @M field/);
    });

    it('throws on unknown model type', () => {
      assert.throws(() => {
        reflection.createModelFacade({'@M': 'Unknown#1'});
      }, /Unknown model type/);
    });

    it('caches facade - same @M returns same object', () => {
      reflection.registerModel('Counter', ReflectedCounter);

      const sig = reflection.getOrCreateSignal(10, 0);
      const facade1 = reflection.createModelFacade({
        '@M': 'Counter#x',
        count: sig,
      });
      const facade2 = reflection.createModelFacade({
        '@M': 'Counter#x',
        count: sig,
      });
      assert.equal(facade1, facade2);
    });

    it('different @M markers get different facades', () => {
      reflection.registerModel('Counter', ReflectedCounter);

      const facade1 = reflection.createModelFacade({
        '@M': 'Counter#1',
        count: reflection.getOrCreateSignal(10, 0),
      });
      const facade2 = reflection.createModelFacade({
        '@M': 'Counter#2',
        count: reflection.getOrCreateSignal(11, 0),
      });
      assert.notEqual(facade1, facade2);
    });
  });

  describe('handleUpdate', () => {
    it('full replace: sets signal value directly', () => {
      const sig = reflection.getOrCreateSignal(1, 'old');
      reflection.handleUpdate(1, 'new');
      assert.equal(sig.peek(), 'new');
    });

    it('append array: concatenates new items', () => {
      const sig = reflection.getOrCreateSignal(1, [1, 2]);
      reflection.handleUpdate(1, [3, 4], 'append');
      assert.deepEqual(sig.peek(), [1, 2, 3, 4]);
    });

    it('append string: concatenates new string', () => {
      const sig = reflection.getOrCreateSignal(1, 'hello');
      reflection.handleUpdate(1, ' world', 'append');
      assert.equal(sig.peek(), 'hello world');
    });

    it('merge object: spreads new properties into current', () => {
      const sig = reflection.getOrCreateSignal(1, {a: 1, b: 2});
      reflection.handleUpdate(1, {b: 3, c: 4}, 'merge');
      assert.deepEqual(sig.peek(), {a: 1, b: 3, c: 4});
    });

    it('splice array: applies splice operation', () => {
      const sig = reflection.getOrCreateSignal(1, ['a', 'b', 'c', 'd']);
      reflection.handleUpdate(
        1,
        {start: 1, deleteCount: 2, items: ['x', 'y', 'z']},
        'splice',
      );
      assert.deepEqual(sig.peek(), ['a', 'x', 'y', 'z', 'd']);
    });

    it('no-op for unknown signal id', () => {
      // Should not throw
      reflection.handleUpdate(999, 'value');
    });

    it('unknown mode falls back to full replace', () => {
      const sig = reflection.getOrCreateSignal(1, 'old');
      reflection.handleUpdate(1, 'replaced', 'unknownMode');
      assert.equal(sig.peek(), 'replaced');
    });
  });
});
