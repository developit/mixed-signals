import {describe, expect, it} from 'vitest';
import type {WireContext} from '../../client/reflection.ts';
import {RPCClient} from '../../client/rpc.ts';
import type {Transport} from '../../shared/protocol.ts';
import {ReflectedCounter} from '../helpers.ts';

class FakeTransport implements Transport {
  sent: string[] = [];
  ready?: Promise<void>;
  private handler?: (data: {toString(): string}) => void;
  constructor(ready?: Promise<void>) {
    this.ready = ready;
  }
  send(data: string) {
    this.sent.push(data);
  }
  onMessage(cb: (data: {toString(): string}) => void) {
    this.handler = cb;
  }
  emit(data: string) {
    this.handler?.({toString: () => data});
  }
}

function createContext(): WireContext {
  return {
    rpc: {call: async () => undefined} as Partial<RPCClient>,
  } as unknown as WireContext;
}

describe('RPCClient', () => {
  describe('message parsing', () => {
    it('parses R{id}:payload as result and resolves pending call', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      const result = client.call('test', []);
      transport.emit('R1:42');
      expect(await result).toBe(42);
    });

    it('parses E{id}:payload as error and rejects pending call', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      const result = client.call('fail', []);
      transport.emit('E1:{"code":-1,"message":"oops"}');
      await expect(result).rejects.toThrow('oops');
    });

    it('applies reviver: @S markers become signals', () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      transport.emit('N:@R:{"@S":1,"v":42}');
      expect(client.root.peek()).toBe(42);
    });

    it('applies reviver: @M markers become model facades', () => {
      const transport = new FakeTransport();
      const ctx = createContext();
      const client = new RPCClient(transport, ctx);
      client.registerModel('Counter', ReflectedCounter);
      transport.emit(
        'N:@R:{"@M":"Counter#5","count":{"@S":10,"v":0},"name":{"@S":11,"v":"default"},"items":{"@S":12,"v":[]},"meta":{"@S":13,"v":{}}}',
      );
      expect(client.root.id.peek()).toBe('5');
    });

    it('ignores unparseable messages', () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      transport.emit('garbage');
      transport.emit('X1:invalid');
      // No throw, no crash
      expect(client.root).toBeUndefined();
    });
  });

  describe('call', () => {
    it('sends M{id}:method:params format', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      const pending = client.call('doSomething', [1, 'two']);
      transport.emit('R1:null');
      await pending;
      expect(transport.sent[0]).toBe('M1:doSomething:1,"two"');
    });

    it('increments message IDs', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      const a = client.call('a', []);
      const b = client.call('b', []);
      const c = client.call('c', []);
      transport.emit('R1:null');
      transport.emit('R2:null');
      transport.emit('R3:null');
      await Promise.all([a, b, c]);
      expect(transport.sent[0]).toMatch(/^M1:/);
      expect(transport.sent[1]).toMatch(/^M2:/);
      expect(transport.sent[2]).toMatch(/^M3:/);
    });

    it('waits for transport.ready if present', async () => {
      let resolveReady!: () => void;
      const ready = new Promise<void>((r) => {
        resolveReady = r;
      });
      const transport = new FakeTransport(ready);
      const client = new RPCClient(transport, createContext());
      const pending = client.call('ping', []);
      // The call should not have been sent yet because transport is not ready
      expect(transport.sent).toHaveLength(0);
      resolveReady();
      // Wait for the call to be flushed
      await new Promise((r) => setTimeout(r, 10));
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]).toMatch(/^M1:ping:/);
      transport.emit('R1:null');
      await pending;
    });

    it('resolves and rejects pending calls from result and error frames', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());

      const sum1 = client.call('sum', [1, 2]);
      expect(transport.sent[0]).toBe('M1:sum:1,2');
      transport.emit('R1:3');
      expect(await sum1).toBe(3);

      const sum2 = client.call('sum', []);
      transport.emit('E2:{"message":"boom"}');
      await expect(sum2).rejects.toThrow('boom');
    });
  });

  describe('notify', () => {
    it('sends N:method:params format', () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      client.notify('ping', [1, 2, 3]);
      expect(transport.sent[0]).toBe('N:ping:1,2,3');
    });

    it('handles empty params', () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      client.notify('ping');
      expect(transport.sent[0]).toBe('N:ping:');
    });

    it('waits for transport.ready before sending', async () => {
      let resolveReady!: () => void;
      const ready = new Promise<void>((r) => {
        resolveReady = r;
      });
      const transport = new FakeTransport(ready);
      const client = new RPCClient(transport, createContext());
      client.notify('ping', [1]);
      // Not sent yet — transport not ready
      expect(transport.sent).toHaveLength(0);
      resolveReady();
      await ready;
      // Flush microtask (.then callback)
      await new Promise((r) => setTimeout(r, 0));
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]).toBe('N:ping:1');
    });
  });

  describe('handleNotification', () => {
    it('@R sets root and resolves ready promise', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      transport.emit('N:@R:{"value":"root-data"}');
      await client.ready;
      expect(client.root).toEqual({value: 'root-data'});
    });

    it('@S calls reflection.handleUpdate', () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      const sig = client.reflection.getOrCreateSignal(5, 'old');
      transport.emit('N:@S:5,"new"');
      expect(sig.peek()).toBe('new');
    });

    it('@S with delta mode', () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      const sig = client.reflection.getOrCreateSignal(5, [1, 2]);
      transport.emit('N:@S:5,[3,4],"append"');
      expect(sig.peek()).toEqual([1, 2, 3, 4]);
    });

    it('hydrates nested signals inside plain objects and arrays', () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());

      // Emit root containing an array with signal markers
      transport.emit(
        'N:@R:{"items":[{"@S":1,"v":"alpha"},{"@S":2,"v":"beta"}],"label":{"@S":3,"v":"list"}}',
      );

      // Check that signal markers were hydrated into signals
      expect(client.root.items[0].peek()).toBe('alpha');
      expect(client.root.items[1].peek()).toBe('beta');
      expect(client.root.label.peek()).toBe('list');

      // Update individual signals
      transport.emit('N:@S:1,"alpha-updated"');
      expect(client.root.items[0].peek()).toBe('alpha-updated');

      // Append update
      transport.emit('N:@S:3,"-updated","append"');
      expect(client.root.label.peek()).toBe('list-updated');
    });

    it('custom notifications forwarded to onNotification listeners', () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      const received: Array<{method: string; params: unknown[]}> = [];
      client.onNotification((method, params) => {
        received.push({method, params});
      });
      transport.emit('N:custom:1,"hello"');
      expect(received).toHaveLength(1);
      expect(received[0].method).toBe('custom');
      expect(received[0].params).toEqual([1, 'hello']);
    });

    it('onNotification returns unsubscribe function', () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      const received: Array<{method: string; params: unknown[]}> = [];
      const unsubscribe = client.onNotification((method, params) => {
        received.push({method, params});
      });
      transport.emit('N:test1:');
      unsubscribe();
      transport.emit('N:test2:');
      expect(received).toHaveLength(1);
      expect(received[0].method).toBe('test1');
    });
  });

  describe('expose', () => {
    it('dispatches a top-level method against the exposed root and emits R', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      client.expose({echo: (a: unknown, b: unknown) => [b, a]});

      transport.emit('M7:echo:1,"two"');
      await new Promise((r) => setTimeout(r, 0));

      expect(transport.sent).toContain('R7:["two",1]');
    });

    it('walks dotted method names against nested objects', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      client.expose({browser: {logs: () => ['a', 'b']}});

      transport.emit('M4:browser.logs:');
      await new Promise((r) => setTimeout(r, 0));

      expect(transport.sent).toContain('R4:["a","b"]');
    });

    it('binds `this` to the immediate receiver, not the root', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      client.expose({
        browser: {
          tag: 'b',
          name() {
            return (this as {tag: string}).tag;
          },
        },
      });

      transport.emit('M1:browser.name:');
      await new Promise((r) => setTimeout(r, 0));

      expect(transport.sent).toContain('R1:"b"');
    });

    it('awaits async handlers before sending R', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      client.expose({slow: async (n: number) => n * 2});

      transport.emit('M3:slow:21');
      await new Promise((r) => setTimeout(r, 20));

      expect(transport.sent).toContain('R3:42');
    });

    it('thrown handler errors surface as E with message', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      client.expose({
        boom: () => {
          throw new Error('nope');
        },
      });

      transport.emit('M9:boom:');
      await new Promise((r) => setTimeout(r, 0));

      expect(transport.sent).toContain('E9:{"code":-1,"message":"nope"}');
    });

    it('rejected promises surface as E', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      client.expose({
        reject: async () => {
          throw new Error('async-bad');
        },
      });

      transport.emit('M2:reject:');
      await new Promise((r) => setTimeout(r, 0));

      expect(transport.sent).toContain('E2:{"code":-1,"message":"async-bad"}');
    });

    it('unknown method emits E with "Method not found"', () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      client.expose({});

      transport.emit('M5:unknown:');

      expect(transport.sent).toContain(
        'E5:{"code":-1,"message":"Method not found: unknown"}',
      );
    });

    it('partial dotted path that does not resolve to a function emits "Method not found"', () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      client.expose({browser: {}});

      transport.emit('M6:browser.missing:');

      expect(transport.sent).toContain(
        'E6:{"code":-1,"message":"Method not found: browser.missing"}',
      );
    });

    it('inbound call before expose emits "Method not found"', () => {
      const transport = new FakeTransport();
      new RPCClient(transport, createContext());

      transport.emit('M1:anything:');

      expect(transport.sent).toContain(
        'E1:{"code":-1,"message":"Method not found: anything"}',
      );
    });

    it('re-exposing replaces the prior root', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      client.expose({which: () => 'first'});
      client.expose({which: () => 'second'});

      transport.emit('M1:which:');
      await new Promise((r) => setTimeout(r, 0));

      expect(transport.sent).toContain('R1:"second"');
    });
  });

  describe('reconnect', () => {
    it('rejects in-flight RPCs with reconnection error', async () => {
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());

      const pending = client.call('slow', []);
      const transport2 = new FakeTransport();
      client.reconnect(transport2);

      await expect(pending).rejects.toThrow('Transport reconnected');
    });

    it('resets the ready gate until new @R arrives', async () => {
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());
      transport1.emit('N:@R:{"v":1}');
      await client.ready;

      const transport2 = new FakeTransport();
      client.reconnect(transport2);

      let resolved = false;
      client.ready.then(() => {
        resolved = true;
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);

      // New @R on new transport resolves ready
      transport2.emit('N:@R:{"v":2}');
      await client.ready;
      expect(client.root).toEqual({v: 2});
    });

    it('uses the new transport for subsequent calls', async () => {
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());

      const transport2 = new FakeTransport();
      client.reconnect(transport2);

      const pending = client.call('ping', []);
      transport2.emit('R1:"pong"');
      expect(await pending).toBe('pong');

      // Call went to transport2, not transport1
      expect(transport2.sent).toHaveLength(1);
      expect(transport2.sent[0]).toMatch(/^M\d+:ping:/);
    });

    it('clears reflection state so new signals are created fresh', () => {
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());

      const oldSig = client.reflection.getOrCreateSignal(1, 'old');
      expect(oldSig.peek()).toBe('old');

      const transport2 = new FakeTransport();
      client.reconnect(transport2);

      // Same ID but should get a new signal instance
      const newSig = client.reflection.getOrCreateSignal(1, 'fresh');
      expect(newSig).not.toBe(oldSig);
      expect(newSig.peek()).toBe('fresh');
    });

    it('processes messages on the new transport', () => {
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());

      const transport2 = new FakeTransport();
      client.reconnect(transport2);

      // Signal update via new transport
      const sig = client.reflection.getOrCreateSignal(5, 'init');
      transport2.emit('N:@S:5,"updated"');
      expect(sig.peek()).toBe('updated');
    });

    it('preserves model registry across reconnect', () => {
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());
      client.registerModel('Counter', ReflectedCounter);

      const transport2 = new FakeTransport();
      client.reconnect(transport2);

      // Model type should still be registered
      transport2.emit(
        'N:@R:{"@M":"Counter#1","count":{"@S":1,"v":0},"name":{"@S":2,"v":"x"},"items":{"@S":3,"v":[]},"meta":{"@S":4,"v":{}}}',
      );
      expect(client.root.id.peek()).toBe('1');
    });
  });
});
