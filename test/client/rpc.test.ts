import {afterEach, describe, expect, it, vi} from 'vitest';
import type {WireContext} from '../../client/reflection.ts';
import {RPCClient} from '../../client/rpc.ts';
import type {Transport} from '../../shared/protocol.ts';
import {ReflectedCounter} from '../helpers.ts';

class FakeTransport implements Transport {
  sent: string[] = [];
  ready?: Promise<void>;
  onOpen?: (cb: () => void) => void;
  private handler?: (data: {toString(): string}) => void;
  private closeHandler?: (error?: unknown) => void;
  private openHandler?: () => void;
  constructor(ready?: Promise<void>, reconnectable = false) {
    this.ready = ready;
    if (reconnectable) {
      this.onOpen = (cb: () => void) => {
        this.openHandler = cb;
      };
    }
  }
  send(data: string) {
    this.sent.push(data);
  }
  onMessage(cb: (data: {toString(): string}) => void) {
    this.handler = cb;
  }
  onClose(cb: (error?: unknown) => void) {
    this.closeHandler = cb;
  }
  emit(data: string) {
    this.handler?.({toString: () => data});
  }
  open() {
    this.openHandler?.();
  }
  close(error?: unknown) {
    this.closeHandler?.(error);
  }
}

function createContext(): WireContext {
  return {
    rpc: {call: async () => undefined} as Partial<RPCClient>,
  } as unknown as WireContext;
}

afterEach(() => {
  vi.useRealTimers();
});

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

    it('rejects calls if the transport disconnects before transport.ready', async () => {
      const ready = new Promise<void>(() => undefined);
      const transport = new FakeTransport(ready);
      const client = new RPCClient(transport, createContext());
      void client.ready.catch(() => undefined);

      const pending = client.call('ping', []);
      expect(transport.sent).toHaveLength(0);

      transport.close();

      await expect(pending).rejects.toThrow('Transport disconnected');
    });

    it('allows calls after a reconnectable transport opens again', async () => {
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((_, reject) => {
        rejectReady = reject;
      });
      const transport = new FakeTransport(ready, true);
      const client = new RPCClient(transport, createContext());
      void client.ready.catch(() => undefined);

      transport.close(new Error('closed'));
      rejectReady(new Error('closed'));
      await Promise.resolve();

      transport.open();
      const pending = client.call('ping', []);
      expect(transport.sent[0]).toBe('M1:ping:');
      transport.emit('R1:"pong"');
      await expect(pending).resolves.toBe('pong');
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

    it('rejects pending calls when the transport disconnects', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      void client.ready.catch(() => undefined);

      const pending = client.call('sum', [1, 2]);
      expect(transport.sent[0]).toBe('M1:sum:1,2');

      transport.close();

      await expect(pending).rejects.toThrow('Transport disconnected');
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

    it('rejects ready when a non-reconnectable transport disconnects before root arrives', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());

      transport.close();

      await expect(client.ready).rejects.toThrow('Transport disconnected');
    });

    it('keeps ready pending for reconnectable transports until root arrives', async () => {
      vi.useFakeTimers();
      const transport = new FakeTransport(undefined, true);
      const client = new RPCClient(transport, createContext());

      transport.close();

      let resolved = false;
      client.ready.then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(resolved).toBe(false);

      transport.open();
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

    it('ignores stale messages from an old transport after reconnect', async () => {
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());
      transport1.emit('N:@R:{"v":1}');
      await client.ready;

      const transport2 = new FakeTransport();
      client.reconnect(transport2);
      transport1.emit('N:@R:{"v":999}');
      expect(client.root).toEqual({v: 1});

      transport2.emit('N:@R:{"v":2}');
      await client.ready;
      expect(client.root).toEqual({v: 2});
    });

    it('does not send calls queued on an old transport.ready after reconnect', async () => {
      let resolveReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const transport1 = new FakeTransport(ready);
      const client = new RPCClient(transport1, createContext());

      const pending = client.call('ping', []);
      const transport2 = new FakeTransport();
      client.reconnect(transport2);
      await expect(pending).rejects.toThrow('Transport reconnected');

      resolveReady();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(transport1.sent).toHaveLength(0);
      expect(transport2.sent).toHaveLength(0);
    });

    it('keeps reflection state so reconnect snapshots can refresh existing signals', () => {
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());

      const oldSig = client.reflection.getOrCreateSignal(1, 'old');
      expect(oldSig.peek()).toBe('old');

      const transport2 = new FakeTransport();
      client.reconnect(transport2);

      const newSig = client.reflection.getOrCreateSignal(1, 'fresh');
      expect(newSig).toBe(oldSig);
      expect(newSig.peek()).toBe('old');
    });

    it('refreshes existing root signals from the reconnect root snapshot', async () => {
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());
      transport1.emit('N:@R:{"count":{"@S":1,"v":1}}');
      await client.ready;

      const root = client.root;
      const count = client.root.count;

      const transport2 = new FakeTransport();
      client.reconnect(transport2);
      transport2.emit('N:@R:{"count":{"@S":1,"v":2}}');
      await client.ready;

      expect(client.root).toBe(root);
      expect(client.root.count).toBe(count);
      expect(count.peek()).toBe(2);
    });

    it('rebinds active root signals when a new process assigns different signal ids', async () => {
      vi.useFakeTimers();
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());
      transport1.emit(
        'N:@R:{"count":{"@S":1,"v":1}},{"connectionId":"c1","processId":"p1","resumed":false}',
      );
      await client.ready;

      const count = client.root.count;
      count.subscribe(() => undefined);
      vi.advanceTimersByTime(1);
      expect(transport1.sent).toContain('N:@W:1');

      const transport2 = new FakeTransport();
      client.reconnect(transport2);
      transport2.emit(
        'N:@R:{"count":{"@S":9,"v":9}},{"connectionId":"c1","processId":"p2","resumed":false}',
      );
      await client.ready;

      expect(client.root.count).toBe(count);
      expect(count.peek()).toBe(9);
      expect(transport2.sent).toContain('N:@W:9');

      transport2.emit('N:@S:9,10');
      expect(count.peek()).toBe(10);
    });

    it('replaces unbranded nested arrays and plain objects on reconnect', async () => {
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());
      transport1.emit(
        'N:@R:{"items":[{"name":"old"}],"settings":{"mode":"light"},"count":{"@S":1,"v":1}}',
      );
      await client.ready;

      const root = client.root;
      const items = root.items;
      const settings = root.settings;
      const count = root.count;

      const transport2 = new FakeTransport();
      client.reconnect(transport2);
      transport2.emit(
        'N:@R:{"items":[{"name":"new"}],"settings":{"mode":"dark"},"count":{"@S":1,"v":2}}',
      );
      await client.ready;

      expect(client.root).toBe(root);
      expect(client.root.count).toBe(count);
      expect(count.peek()).toBe(2);
      expect(client.root.items).not.toBe(items);
      expect(client.root.items).toEqual([{name: 'new'}]);
      expect(client.root.settings).not.toBe(settings);
      expect(client.root.settings).toEqual({mode: 'dark'});
    });

    it('does not rebind signals inside replaced nested plain objects across process changes', async () => {
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());
      transport1.emit(
        'N:@R:{"settings":{"theme":{"@S":1,"v":"light"}}},{"connectionId":"c1","processId":"p1","resumed":false}',
      );
      await client.ready;

      const settings = client.root.settings;
      const theme = settings.theme;

      const transport2 = new FakeTransport();
      client.reconnect(transport2);
      transport2.emit(
        'N:@R:{"settings":{"theme":{"@S":9,"v":"dark"}}},{"connectionId":"c1","processId":"p2","resumed":false}',
      );
      await client.ready;

      expect(client.root.settings).not.toBe(settings);
      expect(client.root.settings.theme).not.toBe(theme);
      expect(theme.peek()).toBe('light');
      expect(client.root.settings.theme.peek()).toBe('dark');
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

    it('refreshes existing reflected model facades across process changes', async () => {
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());
      client.registerModel('Counter', ReflectedCounter);
      transport1.emit(
        'N:@R:{"@M":"Counter#1","count":{"@S":1,"v":0},"name":{"@S":2,"v":"x"},"items":{"@S":3,"v":[]},"meta":{"@S":4,"v":{}}},{"connectionId":"c1","processId":"p1","resumed":false}',
      );
      await client.ready;

      const model = client.root;
      const count = model.count;
      expect(count.peek()).toBe(0);

      const transport2 = new FakeTransport();
      client.reconnect(transport2);
      transport2.emit(
        'N:@R:{"@M":"Counter#1","count":{"@S":10,"v":5},"name":{"@S":20,"v":"y"},"items":{"@S":30,"v":[]},"meta":{"@S":40,"v":{}}},{"connectionId":"c1","processId":"p2","resumed":false}',
      );
      await client.ready;

      expect(client.root).toBe(model);
      expect(model.count).toBe(count);
      expect(count.peek()).toBe(5);

      expect(transport2.sent[0]).toBe('M1:@M:"Counter#1"');

      const pending = model.increment();
      expect(transport2.sent.at(-1)).toBe('M2:1#increment:');
      transport2.emit('R2:null');
      await pending;
    });

    it('does not reuse raw signal ids across different server processes', async () => {
      vi.useFakeTimers();
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());
      client.registerModel('Counter', ReflectedCounter);
      transport1.emit(
        'N:@R:{"root":true},{"connectionId":"c1","processId":"p1","resumed":false}',
      );
      await client.ready;

      const held = client.reflection.createModelFacade({
        '@M': 'Counter#held',
        count: client.reflection.getOrCreateSignal(1, 1),
        name: client.reflection.getOrCreateSignal(2, 'x'),
        items: client.reflection.getOrCreateSignal(3, []),
        meta: client.reflection.getOrCreateSignal(4, {}),
      });
      const heldCount = held.count;
      heldCount.subscribe(() => undefined);
      vi.advanceTimersByTime(1);
      expect(transport1.sent).toContain('N:@W:1');

      const transport2 = new FakeTransport();
      client.reconnect(transport2);
      transport2.emit(
        'N:@R:{"label":{"@S":1,"v":"new-root-signal"}},{"connectionId":"c1","processId":"p2","resumed":false}',
      );
      await client.ready;

      expect(client.root.label).not.toBe(heldCount);
      expect(client.root.label.peek()).toBe('new-root-signal');
      expect(heldCount.peek()).toBe(1);

      transport2.emit(
        'R1:[{"@M":"Counter#held","count":{"@S":2,"v":5},"name":{"@S":3,"v":"y"},"items":{"@S":4,"v":[]},"meta":{"@S":5,"v":{}}}]',
      );
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(1);

      expect(heldCount.peek()).toBe(5);
      expect(transport2.sent).toContain('N:@W:2');
    });

    it('keeps root signals live when held model refresh shares the same new signal id', async () => {
      vi.useFakeTimers();
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());
      client.registerModel('Counter', ReflectedCounter);
      transport1.emit(
        'N:@R:{"shared":{"@S":1,"v":1}},{"connectionId":"c1","processId":"p1","resumed":false}',
      );
      await client.ready;

      const shared = client.root.shared;
      const held = client.reflection.createModelFacade({
        '@M': 'Counter#held',
        count: client.reflection.getOrCreateSignal(2, 1),
        name: client.reflection.getOrCreateSignal(3, 'x'),
        items: client.reflection.getOrCreateSignal(4, []),
        meta: client.reflection.getOrCreateSignal(5, {}),
      });
      const heldCount = held.count;
      shared.subscribe(() => undefined);
      heldCount.subscribe(() => undefined);
      vi.advanceTimersByTime(1);

      const transport2 = new FakeTransport();
      client.reconnect(transport2);
      transport2.emit(
        'N:@R:{"shared":{"@S":9,"v":5}},{"connectionId":"c1","processId":"p2","resumed":false}',
      );
      await client.ready;
      transport2.emit(
        'R1:[{"@M":"Counter#held","count":{"@S":9,"v":5},"name":{"@S":10,"v":"y"},"items":{"@S":11,"v":[]},"meta":{"@S":12,"v":{}}}]',
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(client.root.shared).toBe(shared);
      expect(held.count).toBe(heldCount);
      expect(shared.peek()).toBe(5);
      expect(heldCount.peek()).toBe(5);

      transport2.emit('N:@S:9,6');

      expect(shared.peek()).toBe(6);
      expect(heldCount.peek()).toBe(6);
    });

    it('treats reconnect root snapshots without connection metadata as process changes', async () => {
      vi.useFakeTimers();
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());
      client.registerModel('Counter', ReflectedCounter);
      transport1.emit('N:@R:{"root":true}');
      await client.ready;

      const held = client.reflection.createModelFacade({
        '@M': 'Counter#held',
        count: client.reflection.getOrCreateSignal(1, 1),
        name: client.reflection.getOrCreateSignal(2, 'x'),
        items: client.reflection.getOrCreateSignal(3, []),
        meta: client.reflection.getOrCreateSignal(4, {}),
      });
      const heldCount = held.count;
      heldCount.subscribe(() => undefined);
      vi.advanceTimersByTime(1);
      expect(transport1.sent).toContain('N:@W:1');

      const transport2 = new FakeTransport();
      client.reconnect(transport2);
      transport2.emit('N:@R:{"label":{"@S":1,"v":"new-root-signal"}}');
      await client.ready;

      expect(client.connectionInfo).toBeUndefined();
      expect(client.connectionId).toBeUndefined();
      expect(client.root.label).not.toBe(heldCount);
      expect(client.root.label.peek()).toBe('new-root-signal');
      expect(heldCount.peek()).toBe(1);
    });

    it('clears stale connection metadata when a root snapshot omits it', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      transport.emit(
        'N:@R:{"count":{"@S":1,"v":1}},{"connectionId":"c1","processId":"p1","resumed":false}',
      );
      await client.ready;
      expect(client.connectionId).toBe('c1');

      transport.emit('N:@R:{"count":{"@S":1,"v":2}}');

      expect(client.connectionInfo).toBeUndefined();
      expect(client.connectionId).toBeUndefined();
      expect(client.root.count.peek()).toBe(2);
    });

    it('refreshes held model facades that are not present in the reconnect root', async () => {
      vi.useFakeTimers();
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());
      client.registerModel('Counter', ReflectedCounter);
      transport1.emit('N:@R:{"root":true}');
      await client.ready;

      const held = client.reflection.createModelFacade({
        '@M': 'Counter#held',
        count: client.reflection.getOrCreateSignal(1, 1),
        name: client.reflection.getOrCreateSignal(2, 'x'),
        items: client.reflection.getOrCreateSignal(3, []),
        meta: client.reflection.getOrCreateSignal(4, {}),
      });
      const count = held.count;
      count.subscribe(() => undefined);
      vi.advanceTimersByTime(1);
      expect(transport1.sent).toContain('N:@W:1');

      const transport2 = new FakeTransport();
      client.reconnect(transport2);
      transport2.emit('N:@R:{"root":true}');
      await client.ready;
      expect(transport2.sent[0]).toBe('M1:@M:"Counter#held"');

      transport2.emit(
        'R1:[{"@M":"Counter#held","count":{"@S":10,"v":5},"name":{"@S":20,"v":"y"},"items":{"@S":30,"v":[]},"meta":{"@S":40,"v":{}}}]',
      );
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(1);

      expect(held.count).toBe(count);
      expect(count.peek()).toBe(5);
      expect(transport2.sent).toContain('N:@W:10');

      transport2.emit('N:@S:10,6');
      expect(count.peek()).toBe(6);
    });

    it('watches refreshed reflected model signals after process changes', async () => {
      vi.useFakeTimers();
      const transport1 = new FakeTransport();
      const client = new RPCClient(transport1, createContext());
      client.registerModel('Counter', ReflectedCounter);
      transport1.emit(
        'N:@R:{"@M":"Counter#1","count":{"@S":1,"v":0},"name":{"@S":2,"v":"x"},"items":{"@S":3,"v":[]},"meta":{"@S":4,"v":{}}},{"connectionId":"c1","processId":"p1","resumed":false}',
      );
      await client.ready;

      const count = client.root.count;
      count.subscribe(() => undefined);
      vi.advanceTimersByTime(1);
      expect(transport1.sent).toContain('N:@W:1');

      const transport2 = new FakeTransport();
      client.reconnect(transport2);
      transport2.emit(
        'N:@R:{"@M":"Counter#1","count":{"@S":10,"v":5},"name":{"@S":20,"v":"y"},"items":{"@S":30,"v":[]},"meta":{"@S":40,"v":{}}},{"connectionId":"c1","processId":"p2","resumed":false}',
      );
      await client.ready;
      expect(transport2.sent[0]).toBe('M1:@M:"Counter#1"');
      transport2.emit(
        'R1:[{"@M":"Counter#1","count":{"@S":10,"v":5},"name":{"@S":20,"v":"y"},"items":{"@S":30,"v":[]},"meta":{"@S":40,"v":{}}}]',
      );
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(1);

      expect(count.peek()).toBe(5);
      expect(transport2.sent).toContain('N:@W:10');

      transport2.emit('N:@S:10,6');
      expect(count.peek()).toBe(6);
    });
  });
});
