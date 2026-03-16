import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {RPCClient} from '../../client/rpc.ts';
import type {Transport} from '../../server/rpc.ts';
import {ReflectedCounter} from '../helpers.ts';

function createMockTransport(): {
  transport: Transport;
  simulateMessage(msg: string): void;
  sent: string[];
} {
  let cb: ((data: {toString(): string}) => void) | null = null;
  const sent: string[] = [];
  return {
    transport: {
      send(data: string) {
        sent.push(data);
      },
      onMessage(handler) {
        cb = handler;
      },
    },
    simulateMessage(msg: string) {
      cb?.({toString: () => msg});
    },
    sent,
  };
}

describe('RPCClient', () => {
  let mock: ReturnType<typeof createMockTransport>;
  let client: RPCClient;
  let ctx: any;

  beforeEach(() => {
    mock = createMockTransport();
    ctx = {rpc: null as any};
    client = new RPCClient(mock.transport, ctx);
    ctx.rpc = client;
  });

  describe('message parsing', () => {
    it('parses R{id}:payload as result and resolves pending call', async () => {
      const promise = client.call('test');
      // call sends M1:test:
      mock.simulateMessage('R1:42');
      const result = await promise;
      assert.equal(result, 42);
    });

    it('parses E{id}:payload as error and rejects pending call', async () => {
      const promise = client.call('fail');
      mock.simulateMessage('E1:{"code":-1,"message":"oops"}');
      await assert.rejects(promise, {message: 'oops'});
    });

    it('applies reviver: @S markers become signals', () => {
      // Send @R notification with signal markers
      mock.simulateMessage('N:@R:{"@S":1,"v":42}');
      // The root should be a signal
      assert.ok(client.root);
      assert.equal(client.root.peek(), 42);
    });

    it('applies reviver: @M markers become model facades', () => {
      client.reflection.registerModel('Counter', ReflectedCounter);

      // Send @R with a model containing signal props
      mock.simulateMessage(
        'N:@R:{"@M":"Counter#5","count":{"@S":1,"v":0},"name":{"@S":2,"v":"test"}}',
      );

      assert.ok(client.root);
      assert.equal(client.root.id.peek(), '5');
    });

    it('ignores unparseable messages', () => {
      // Should not throw
      mock.simulateMessage('garbage');
      mock.simulateMessage('X1:invalid');
    });
  });

  describe('call', () => {
    it('sends M{id}:method:params format', () => {
      client.call('doSomething', [1, 'two']);
      assert.equal(mock.sent.length, 1);
      assert.equal(mock.sent[0], 'M1:doSomething:1,"two"');
    });

    it('increments message IDs', () => {
      client.call('a');
      client.call('b');
      client.call('c');
      assert.ok(mock.sent[0].startsWith('M1:'));
      assert.ok(mock.sent[1].startsWith('M2:'));
      assert.ok(mock.sent[2].startsWith('M3:'));
    });

    it('waits for transport.ready if present', async () => {
      let resolveReady!: () => void;
      const readyTransport: Transport = {
        send(data) {
          mock.transport.send(data);
        },
        onMessage(cb) {
          mock.transport.onMessage(cb);
        },
        ready: new Promise((r) => {
          resolveReady = r;
        }),
      };

      const readyClient = new RPCClient(readyTransport, ctx);
      let resolved = false;
      const _p = readyClient.call('waitForMe').then((v) => {
        resolved = true;
        return v;
      });

      await new Promise((r) => setTimeout(r, 10));
      assert.equal(resolved, false); // still waiting

      resolveReady();
      await new Promise((r) => setTimeout(r, 10));
      // Now the message should have been sent
      assert.ok(mock.sent.some((s) => s.includes('waitForMe')));
    });
  });

  describe('notify', () => {
    it('sends N:method:params format', () => {
      client.notify('ping', [1, 2, 3]);
      assert.equal(mock.sent[0], 'N:ping:1,2,3');
    });

    it('handles empty params', () => {
      client.notify('ping');
      assert.equal(mock.sent[0], 'N:ping:');
    });
  });

  describe('handleNotification', () => {
    it('@R sets root and resolves ready promise', async () => {
      mock.simulateMessage('N:@R:{"value":"root-data"}');
      await client.ready;
      assert.deepEqual(client.root, {value: 'root-data'});
    });

    it('@S calls reflection.handleUpdate', () => {
      const sig = client.reflection.getOrCreateSignal(5, 'old');
      mock.simulateMessage('N:@S:5,"new"');
      assert.equal(sig.peek(), 'new');
    });

    it('@S with delta mode', () => {
      const sig = client.reflection.getOrCreateSignal(5, [1, 2]);
      mock.simulateMessage('N:@S:5,[3,4],"append"');
      assert.deepEqual(sig.peek(), [1, 2, 3, 4]);
    });

    it('custom notifications forwarded to onNotification listeners', () => {
      const received: {method: string; params: any[]}[] = [];
      client.onNotification((method, params) => {
        received.push({method, params});
      });

      mock.simulateMessage('N:custom:1,"hello"');
      assert.equal(received.length, 1);
      assert.equal(received[0].method, 'custom');
      assert.deepEqual(received[0].params, [1, 'hello']);
    });

    it('onNotification returns unsubscribe function', () => {
      const received: any[] = [];
      const unsub = client.onNotification((method) => {
        received.push(method);
      });

      mock.simulateMessage('N:test1:');
      assert.equal(received.length, 1);

      unsub();
      mock.simulateMessage('N:test2:');
      assert.equal(received.length, 1); // no new messages
    });
  });
});
