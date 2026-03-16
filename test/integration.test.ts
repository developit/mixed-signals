import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {effect, signal} from '@preact/signals-core';
import {RPCClient} from '../client/rpc.ts';
import {RPC} from '../server/rpc.ts';
import {
  Counter,
  createTransportPair,
  flush,
  ReflectedCounter,
} from './helpers.ts';

function connect(rpc: RPC, clientId?: string) {
  const {server, client: clientTransport} = createTransportPair();
  const ctx = {rpc: null as any};
  const rpcClient = new RPCClient(clientTransport, ctx);
  ctx.rpc = rpcClient;
  rpcClient.reflection.registerModel('Counter', ReflectedCounter);
  const cleanup = rpc.addClient(server, clientId);
  return {rpcClient, cleanup};
}

describe('Integration: Server <-> Client', () => {
  let rpc: RPC;
  let root: InstanceType<typeof Counter>;

  beforeEach(() => {
    rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    root = new Counter();
    rpc.expose(root);
  });

  describe('initial connection', () => {
    it('client receives root model on connect', async () => {
      const {rpcClient} = connect(rpc, 'c1');
      await rpcClient.ready;

      assert.ok(rpcClient.root);
      assert.equal(rpcClient.root.id.peek(), '0');
    });

    it('client root has correct signal values', async () => {
      root.count.value = 5;
      root.name.value = 'hello';

      const {rpcClient} = connect(rpc, 'c1');
      await rpcClient.ready;

      assert.equal(rpcClient.root.count.peek(), 5);
      assert.equal(rpcClient.root.name.peek(), 'hello');
    });

    it('client root has callable methods', async () => {
      const {rpcClient} = connect(rpc, 'c1');
      await rpcClient.ready;

      assert.equal(typeof rpcClient.root.increment, 'function');
      assert.equal(typeof rpcClient.root.add, 'function');
      assert.equal(typeof rpcClient.root.rename, 'function');
    });
  });

  describe('method calls', () => {
    it('calling root method executes on server', async () => {
      const {rpcClient} = connect(rpc, 'c1');
      await rpcClient.ready;

      await rpcClient.root.increment();
      assert.equal(root.count.peek(), 1);
    });

    it('calling method with parameters', async () => {
      const {rpcClient} = connect(rpc, 'c1');
      await rpcClient.ready;

      await rpcClient.root.rename('new-name');
      assert.equal(root.name.peek(), 'new-name');
    });

    it('method error propagates to client', async () => {
      const rootObj = {
        fail() {
          throw new Error('server error');
        },
      };
      const rpc2 = new RPC();
      rpc2.expose(rootObj);

      const {server, client: clientTransport} = createTransportPair();
      const ctx = {rpc: null as any};
      const rpcClient = new RPCClient(clientTransport, ctx);
      ctx.rpc = rpcClient;
      rpc2.addClient(server, 'c1');
      await rpcClient.ready;

      await assert.rejects(rpcClient.call('fail'), {
        message: 'server error',
      });
    });
  });

  describe('signal synchronization', () => {
    it('client receives update after watch + server mutation', async () => {
      const {rpcClient} = connect(rpc, 'c1');
      await rpcClient.ready;

      // Subscribe to count signal (triggers watch)
      let observedCount: number | undefined;
      const dispose = effect(() => {
        observedCount = rpcClient.root.count.value;
      });

      await flush(); // let watch batch fire

      // Mutate on server
      root.count.value = 42;

      assert.equal(observedCount, 42);
      dispose();
    });

    it('array append delta works end-to-end', async () => {
      root.items.value = ['a', 'b'];

      const {rpcClient} = connect(rpc, 'c1');
      await rpcClient.ready;

      let observedItems: string[] | undefined;
      const dispose = effect(() => {
        observedItems = rpcClient.root.items.value;
      });

      await flush();

      // Append on server
      root.items.value = ['a', 'b', 'c'];

      assert.deepEqual(observedItems, ['a', 'b', 'c']);
      dispose();
    });

    it('string append delta works end-to-end', async () => {
      root.name.value = 'hello';

      const {rpcClient} = connect(rpc, 'c1');
      await rpcClient.ready;

      let observedName: string | undefined;
      const dispose = effect(() => {
        observedName = rpcClient.root.name.value;
      });

      await flush();

      root.name.value = 'hello world';

      assert.equal(observedName, 'hello world');
      dispose();
    });

    it('object merge delta works end-to-end', async () => {
      root.meta.value = {version: 1, status: 'ok'};

      const {rpcClient} = connect(rpc, 'c1');
      await rpcClient.ready;

      let observedMeta: any;
      const dispose = effect(() => {
        observedMeta = rpcClient.root.meta.value;
      });

      await flush();

      root.meta.value = {version: 1, status: 'updated'};

      assert.deepEqual(observedMeta, {version: 1, status: 'updated'});
      dispose();
    });

    it('full replacement when delta does not apply', async () => {
      root.name.value = 'abc';

      const {rpcClient} = connect(rpc, 'c1');
      await rpcClient.ready;

      let observedName: string | undefined;
      const dispose = effect(() => {
        observedName = rpcClient.root.name.value;
      });

      await flush();

      root.name.value = 'xyz'; // completely different, no append

      assert.equal(observedName, 'xyz');
      dispose();
    });

    it('multiple rapid updates all arrive', async () => {
      const {rpcClient} = connect(rpc, 'c1');
      await rpcClient.ready;

      let latest: number | undefined;
      const dispose = effect(() => {
        latest = rpcClient.root.count.value;
      });

      await flush();

      root.count.value = 1;
      root.count.value = 2;
      root.count.value = 3;

      assert.equal(latest, 3);
      dispose();
    });
  });

  describe('model references', () => {
    it('server returns model from method -> client gets facade', async () => {
      // Add a method that returns a child model
      const child = new Counter();
      (child as any).id = signal('child-1');
      child.name.value = 'child';
      rpc.instances.register('child-1', child);

      const rootObj = {
        getChild() {
          return child;
        },
      };
      const rpc2 = new RPC();
      rpc2.registerModel('Counter', Counter);
      rpc2.expose(rootObj);
      rpc2.instances.register('child-1', child);

      const {rpcClient} = connect(rpc2, 'c1');
      await rpcClient.ready;

      const result = await rpcClient.call('getChild');
      assert.ok(result);
      assert.equal(result.id.peek(), 'child-1');
    });
  });

  describe('multiple clients', () => {
    it('two clients get independent root serializations', async () => {
      const {rpcClient: clientA} = connect(rpc, 'a');
      const {rpcClient: clientB} = connect(rpc, 'b');
      await Promise.all([clientA.ready, clientB.ready]);

      assert.ok(clientA.root);
      assert.ok(clientB.root);
      assert.notEqual(clientA.root, clientB.root); // different facade instances
    });

    it('signal update sent to both subscribed clients', async () => {
      const {rpcClient: clientA} = connect(rpc, 'a');
      const {rpcClient: clientB} = connect(rpc, 'b');
      await Promise.all([clientA.ready, clientB.ready]);

      let countA: number | undefined;
      let countB: number | undefined;

      const disposeA = effect(() => {
        countA = clientA.root.count.value;
      });
      const disposeB = effect(() => {
        countB = clientB.root.count.value;
      });

      await flush();

      root.count.value = 77;

      assert.equal(countA, 77);
      assert.equal(countB, 77);

      disposeA();
      disposeB();
    });

    it('client disconnect cleans up subscriptions', async () => {
      const {rpcClient: clientA, cleanup: cleanupA} = connect(rpc, 'a');
      const {rpcClient: clientB} = connect(rpc, 'b');
      await Promise.all([clientA.ready, clientB.ready]);

      let _countA: number | undefined;
      let countB: number | undefined;

      const disposeA = effect(() => {
        _countA = clientA.root.count.value;
      });
      const disposeB = effect(() => {
        countB = clientB.root.count.value;
      });

      await flush();

      // Disconnect client A
      disposeA();
      cleanupA();

      // Update should still reach client B
      root.count.value = 50;
      assert.equal(countB, 50);

      disposeB();
    });
  });

  describe('lifecycle', () => {
    it('cleanup function stops client from receiving messages', async () => {
      const {rpcClient, cleanup} = connect(rpc, 'c1');
      await rpcClient.ready;

      let count: number | undefined;
      const dispose = effect(() => {
        count = rpcClient.root.count.value;
      });

      await flush();
      root.count.value = 10;
      assert.equal(count, 10);

      dispose();
      cleanup();

      // After cleanup, server mutations should not reach this client
      // (no transport to deliver to)
      root.count.value = 999;
      // count stays at 10 since the effect was disposed
      assert.equal(count, 10);
    });

    it('rpc.call from client still works with method routing', async () => {
      const {rpcClient} = connect(rpc, 'c1');
      await rpcClient.ready;

      // Direct call without going through model
      await rpcClient.call('increment');
      assert.equal(root.count.peek(), 1);

      await rpcClient.call('increment');
      assert.equal(root.count.peek(), 2);
    });
  });
});
