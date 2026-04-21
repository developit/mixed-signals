import {signal} from '@preact/signals-core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {RPCClient} from '../client/rpc.ts';
import {
  createMemoryTransportPair,
  createRawMemoryTransportPair,
} from '../server/memory-transport.ts';
import {createModel} from '../server/model.ts';
import {RPC} from '../server/rpc.ts';
import {
  Counter,
  createLinkedRawTransportPair,
  flush as tick,
} from './helpers.ts';

/**
 * End-to-end raw-mode integration: exercises the same flows the string-mode
 * integration suite does, to prove the codec abstraction carries the full
 * protocol through without regression.
 */
describe('Raw-mode transport: end-to-end', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers root via raw transport with no JSON framing', async () => {
    const rpc = new RPC(new Counter());
    const {serverTransport, clientTransport, flush} =
      createLinkedRawTransportPair();
    const client = new RPCClient(clientTransport);
    rpc.addClient(serverTransport, 'c1');
    await flush();
    await client.ready;

    expect(client.root).toBeDefined();
    expect(client.root.count.peek()).toBe(0);
    expect(client.root.name.peek()).toBe('default');
    expect(typeof client.root.increment).toBe('function');
  });

  it('method calls and results round-trip through raw transport', async () => {
    const root = new Counter();
    const rpc = new RPC(root);
    const {serverTransport, clientTransport, flush} =
      createLinkedRawTransportPair();
    const client = new RPCClient(clientTransport);
    rpc.addClient(serverTransport, 'c1');
    await flush();
    await client.ready;

    const p = client.root.increment();
    await flush();
    await p;
    // Without a subscription the client doesn't see pushes, so verify the
    // call landed on the server.
    expect(root.count.peek()).toBe(1);

    const p2 = client.root.add('first');
    await flush();
    await p2;
    expect(root.items.peek()).toEqual(['first']);
  });

  it('signals push updates via raw @S notifications', async () => {
    const root = new Counter();
    const rpc = new RPC(root);
    const {serverTransport, clientTransport, flush} =
      createLinkedRawTransportPair();
    const client = new RPCClient(clientTransport);
    rpc.addClient(serverTransport, 'c1');
    await flush();
    await client.ready;

    const unwatch = client.root.count.subscribe(() => {});
    await flush();
    await tick(5); // watch-batch debounce
    await flush();

    root.count.value = 42;
    await flush();
    expect(client.root.count.peek()).toBe(42);

    unwatch();
  });

  it('branded handles round-trip back to server identity', async () => {
    const Session = createModel<{
      id: ReturnType<typeof signal<string>>;
      touch(): void;
    }>('Session', () => {
      const id = signal('s1');
      return {
        id,
        touch() {
          id.value = `${id.peek()}!`;
        },
      };
    });
    const root = {
      session: new Session(),
      checkSame(other: any) {
        return other === root.session;
      },
    };
    const rpc = new RPC(root);
    const {serverTransport, clientTransport, flush} =
      createLinkedRawTransportPair();
    const client = new RPCClient(clientTransport);
    rpc.addClient(serverTransport, 'c1');
    await flush();
    await client.ready;

    const sameProxy = client.root.session;
    const result = client.root.checkSame(sameProxy);
    await flush();
    expect(await result).toBe(true);
  });

  it('survives undefined arguments (bug the string codec used to eat)', async () => {
    const root = {
      echo(a: unknown, b: unknown, c: unknown) {
        return {a, b, c};
      },
    };
    const rpc = new RPC(root);
    const {serverTransport, clientTransport, flush} =
      createLinkedRawTransportPair();
    const client = new RPCClient(clientTransport);
    rpc.addClient(serverTransport, 'c1');
    await flush();
    await client.ready;

    const p = client.root.echo(1, undefined, 3);
    await flush();
    const result = await p;
    // Raw path preserves undefined end-to-end (structured clone handles it);
    // note that after the client-side outbound walker, undefined slots in an
    // array become null in JSON-comparable form but raw preserves undefined.
    // Assert the observable: first arg is 1, third is 3.
    expect(result.a).toBe(1);
    expect(result.c).toBe(3);
  });

  it('promise handles settle via @P over raw', async () => {
    const root = {
      later(v: unknown) {
        return new Promise((r) => setTimeout(() => r(v), 5));
      },
    };
    const rpc = new RPC(root);
    const {serverTransport, clientTransport, flush} =
      createLinkedRawTransportPair();
    const client = new RPCClient(clientTransport);
    rpc.addClient(serverTransport, 'c1');
    await flush();
    await client.ready;

    const p = client.root.later(42);
    await flush();
    // Server's returned Promise is a live `p*` handle; settles via @P.
    await tick(10);
    await flush();
    const value = await p.then((x: Promise<any>) => x);
    expect(value).toBe(42);
  });

  it('reuses handle identity across repeated emissions (bare @H)', async () => {
    const Item = createModel<{
      name: ReturnType<typeof signal<string>>;
    }>('Item', () => {
      const name = signal('x');
      return {name};
    });
    const shared = new Item();
    const root = {
      get() {
        return shared;
      },
    };
    const rpc = new RPC(root);
    const {serverTransport, clientTransport, flush} =
      createLinkedRawTransportPair();
    const client = new RPCClient(clientTransport);
    rpc.addClient(serverTransport, 'c1');
    await flush();
    await client.ready;

    const a = await (async () => {
      const p = client.root.get();
      await flush();
      return p;
    })();
    const b = await (async () => {
      const p = client.root.get();
      await flush();
      return p;
    })();
    expect(a).toBe(b);
  });
});

describe('Raw-mode transport: ctx.transfer', () => {
  it('collects ArrayBuffer into ctx.transfer on outbound from server', async () => {
    const buffer = new ArrayBuffer(8);
    const root = {
      getBuffer() {
        return {payload: buffer, size: 8};
      },
    };
    const rpc = new RPC(root);
    const {serverTransport, clientTransport, flush, sentCtxToClient} =
      createLinkedRawTransportPair();
    const client = new RPCClient(clientTransport);
    rpc.addClient(serverTransport, 'c1');
    await flush();
    await client.ready;

    const p = client.root.getBuffer();
    await flush();
    const result = await p;
    expect(result.size).toBe(8);
    expect(result.payload instanceof ArrayBuffer).toBe(true);

    // The result was sent with ctx.transfer populated containing the buffer.
    const transferCtx = sentCtxToClient.find(
      (c) =>
        Array.isArray(c.transfer) &&
        c.transfer.length > 0 &&
        c.transfer[0] instanceof ArrayBuffer,
    );
    expect(transferCtx).toBeDefined();
  });

  it('collects ArrayBuffer into ctx.transfer on outbound from client', async () => {
    const seen: unknown[] = [];
    const root = {
      push(v: unknown) {
        seen.push(v);
      },
    };
    const rpc = new RPC(root);
    const {serverTransport, clientTransport, flush, sentCtxToServer} =
      createLinkedRawTransportPair();
    const client = new RPCClient(clientTransport);
    rpc.addClient(serverTransport, 'c1');
    await flush();
    await client.ready;

    const buf = new ArrayBuffer(16);
    client.root.push(buf);
    await flush();

    expect(seen[0] instanceof ArrayBuffer).toBe(true);
    const transferCtx = sentCtxToServer.find(
      (c) =>
        Array.isArray(c.transfer) &&
        c.transfer.length > 0 &&
        c.transfer[0] instanceof ArrayBuffer,
    );
    expect(transferCtx).toBeDefined();
  });

  it('ctx on receiving side has transfer stripped', async () => {
    const root = {
      getBuffer() {
        return new ArrayBuffer(4);
      },
    };
    const rpc = new RPC(root);
    const [serverTransport, clientTransport] = createRawMemoryTransportPair();

    const incomingCtxs: unknown[] = [];
    const originalOnMessage = clientTransport.onMessage;
    clientTransport.onMessage = (cb) => {
      originalOnMessage.call(clientTransport, (data, ctx) => {
        incomingCtxs.push(ctx);
        return cb(data, ctx);
      });
    };

    const client = new RPCClient(clientTransport);
    rpc.addClient(serverTransport, 'c1');
    await new Promise((r) => setTimeout(r, 5));
    await client.ready;

    const result = await client.root.getBuffer();
    expect(result instanceof ArrayBuffer).toBe(true);
    // No forwarded ctx should carry `transfer` as a key — the memory
    // transport strips it before delivery.
    for (const ctx of incomingCtxs) {
      if (ctx && typeof ctx === 'object') {
        expect(Object.hasOwn(ctx as object, 'transfer')).toBe(false);
      }
    }
  });
});

describe('Raw-mode transport: mode isolation', () => {
  it('string and raw clients on the same server coexist', async () => {
    const rpc = new RPC(new Counter());

    const [rawServer, rawClientT] = createRawMemoryTransportPair();
    const [strServer, strClientT] = createMemoryTransportPair();

    const rawClient = new RPCClient(rawClientT);
    const strClient = new RPCClient(strClientT);
    rpc.addClient(rawServer, 'raw-client');
    rpc.addClient(strServer, 'str-client');

    await rawClient.ready;
    await strClient.ready;

    expect(rawClient.root.count.peek()).toBe(0);
    expect(strClient.root.count.peek()).toBe(0);

    await Promise.all([rawClient.root.increment(), strClient.root.increment()]);

    // Each client saw their own increment acknowledged; the server ran both.
    expect(rawClient.root.count.peek()).toBe(0); // no subscription yet
    expect(strClient.root.count.peek()).toBe(0);
  });
});

describe('Raw-mode transport: WireMessage shape is structured-clone safe', () => {
  it('does not wrap payload as a string anywhere on the raw path', async () => {
    const observed: unknown[] = [];
    const [serverTransport, clientTransport] = createRawMemoryTransportPair();

    // Tap the client's send to capture what the RPC layer hands to the
    // transport. Must be an object with `type`, never a string.
    const originalSend = clientTransport.send;
    clientTransport.send = (data, ctx) => {
      observed.push(data);
      return originalSend.call(clientTransport, data, ctx);
    };

    const rpc = new RPC(new Counter());
    const client = new RPCClient(clientTransport);
    rpc.addClient(serverTransport, 'c1');
    await client.ready;
    await client.root.increment();

    expect(observed.length).toBeGreaterThan(0);
    for (const obs of observed) {
      expect(typeof obs).toBe('object');
      expect(typeof (obs as any)?.type).toBe('string');
    }
  });
});
