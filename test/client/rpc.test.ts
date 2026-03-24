import {afterEach, describe, expect, it, vi} from 'vitest';
import type {WireContext} from '../../client/reflection.ts';
import {RPCClient} from '../../client/rpc.ts';
import type {Transport} from '../../shared/protocol.ts';
import {ReflectedCounter} from '../helpers.ts';

class FakeTransport implements Transport {
  sent: string[] = [];
  ready?: Promise<void>;
  closed = false;
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
    this.closed = false;
    this.openHandler?.();
  }
  close(error?: unknown) {
    this.closed = true;
    this.closeHandler?.(error);
  }
}

function createContext(): WireContext {
  return {
    rpc: {call: async () => undefined} as Partial<RPCClient>,
  } as unknown as WireContext;
}

async function settleWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<'resolved' | 'rejected' | 'timeout'> {
  return Promise.race([
    promise.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), ms);
    }),
  ]);
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
      vi.useFakeTimers();
      const ready = new Promise<void>(() => undefined);
      const transport = new FakeTransport(ready);
      const client = new RPCClient(transport, createContext());
      void client.ready.catch(() => undefined);

      const pending = client.call('ping', []);
      expect(transport.sent).toHaveLength(0);

      transport.close();

      const outcome = settleWithin(pending, 20);
      await vi.advanceTimersByTimeAsync(20);

      expect(await outcome).toBe('rejected');
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
      vi.useFakeTimers();
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      void client.ready.catch(() => undefined);

      const pending = client.call('sum', [1, 2]);
      expect(transport.sent[0]).toBe('M1:sum:1,2');

      transport.close();

      const outcome = settleWithin(pending, 20);
      await vi.advanceTimersByTimeAsync(20);

      expect(await outcome).toBe('rejected');
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
  });

  describe('handleNotification', () => {
    it('@R sets root and resolves ready promise', async () => {
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());
      transport.emit('N:@R:{"value":"root-data"}');
      await client.ready;
      expect(client.root).toEqual({value: 'root-data'});
    });

    it('rejects ready when the transport disconnects before root arrives', async () => {
      vi.useFakeTimers();
      const transport = new FakeTransport();
      const client = new RPCClient(transport, createContext());

      transport.close();

      const outcome = settleWithin(client.ready, 20);
      await vi.advanceTimersByTimeAsync(20);

      expect(await outcome).toBe('rejected');
    });

    it('keeps ready pending for reconnectable transports until root arrives', async () => {
      vi.useFakeTimers();
      const transport = new FakeTransport(undefined, true);
      const client = new RPCClient(transport, createContext());

      transport.close();

      const beforeReconnect = settleWithin(client.ready, 20);
      await vi.advanceTimersByTimeAsync(20);
      expect(await beforeReconnect).toBe('timeout');

      transport.open();
      transport.emit('N:@R:{"value":"root-data"}');

      const afterReconnect = settleWithin(client.ready, 20);
      await vi.advanceTimersByTimeAsync(20);
      expect(await afterReconnect).toBe('resolved');
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
});
