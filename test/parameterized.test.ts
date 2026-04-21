import {type Signal, signal} from '@preact/signals-core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {typeOfRemote} from '../client/index.ts';
import {RPCClient} from '../client/rpc.ts';
import {createModel} from '../server/model.ts';
import {RPC} from '../server/rpc.ts';
import type {Transport} from '../shared/protocol.ts';
import {
  Counter,
  createLinkedRawTransportPair,
  createLinkedTransportPair,
  flush as tick,
} from './helpers.ts';

/**
 * Re-run a curated set of core flows against both transport modes. The goal
 * is equivalence: behavior observable to user code should not depend on
 * whether the transport stringifies or passes objects through.
 */
type Mode = 'string' | 'raw';

interface Pair {
  serverTransport: Transport;
  clientTransport: Transport;
  flush: () => Promise<void>;
}

function makePair(mode: Mode): Pair {
  if (mode === 'string') {
    const {serverTransport, clientTransport, flush} =
      createLinkedTransportPair();
    return {serverTransport, clientTransport, flush};
  }
  const {serverTransport, clientTransport, flush} =
    createLinkedRawTransportPair();
  return {serverTransport, clientTransport, flush};
}

function connect(rpc: RPC, mode: Mode, clientId?: string) {
  const {serverTransport, clientTransport, flush} = makePair(mode);
  const client = new RPCClient(clientTransport);
  const cleanup = rpc.addClient(serverTransport, clientId);
  return {client, cleanup, flush};
}

for (const mode of ['string', 'raw'] as const) {
  describe(`Parameterized: ${mode} transport`, () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('root hydration + method dispatch', async () => {
      const root = new Counter();
      const rpc = new RPC(root);
      const {client, flush} = connect(rpc, mode, 'c1');
      await flush();
      await client.ready;

      expect(client.root.count.peek()).toBe(0);
      expect(typeOfRemote(client.root)).toBe('Counter');

      const p = client.root.increment();
      await flush();
      await p;
      expect(root.count.peek()).toBe(1);
    });

    it('subscribe + server-driven update', async () => {
      const root = new Counter();
      const rpc = new RPC(root);
      const {client, flush} = connect(rpc, mode, 'c1');
      await flush();
      await client.ready;

      const observed: number[] = [];
      const unsub = client.root.count.subscribe((v: number) =>
        observed.push(v),
      );
      await flush();
      await tick(5);
      await flush();

      root.count.value = 10;
      await flush();
      root.count.value = 20;
      await flush();

      expect(observed).toContain(10);
      expect(observed).toContain(20);
      unsub();
    });

    it('method with structured return', async () => {
      const root = {
        getUser(id: number) {
          return {id, name: 'jason', email: 'x@y.z'};
        },
      };
      const rpc = new RPC(root);
      const {client, flush} = connect(rpc, mode, 'c1');
      await flush();
      await client.ready;

      const p = client.root.getUser(7);
      await flush();
      expect(await p).toEqual({id: 7, name: 'jason', email: 'x@y.z'});
    });

    it('promise handles settle through @P', async () => {
      const root = {
        later(v: unknown) {
          return new Promise((r) => setTimeout(() => r(v), 5));
        },
      };
      const rpc = new RPC(root);
      const {client, flush} = connect(rpc, mode, 'c1');
      await flush();
      await client.ready;

      const outer = client.root.later(99);
      await flush();
      const inner = await outer;
      await tick(10);
      await flush();
      expect(await inner).toBe(99);
    });

    it('function handles are callable round-trip', async () => {
      const root = {
        makeAdder(x: number) {
          return (y: number) => x + y;
        },
      };
      const rpc = new RPC(root);
      const {client, flush} = connect(rpc, mode, 'c1');
      await flush();
      await client.ready;

      const fnPromise = client.root.makeAdder(5);
      await flush();
      const fn = await fnPromise;
      expect(typeof fn).toBe('function');
      const resultPromise = fn(3);
      await flush();
      expect(await resultPromise).toBe(8);
    });

    it('identity round-trip of branded handles', async () => {
      const Session = createModel<{
        id: ReturnType<typeof signal<string>>;
      }>('Session', () => {
        const id = signal('s1');
        return {id};
      });
      const sessions = {
        current: new Session(),
        isSame(other: any) {
          return other === sessions.current;
        },
      };
      const rpc = new RPC(sessions);
      const {client, flush} = connect(rpc, mode, 'c1');
      await flush();
      await client.ready;

      const s = client.root.current;
      const p = client.root.isSame(s);
      await flush();
      expect(await p).toBe(true);
    });

    it('repeated emission returns the same proxy (bare @H)', async () => {
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
      const {client, flush} = connect(rpc, mode, 'c1');
      await flush();
      await client.ready;

      const aP = client.root.get();
      await flush();
      const a = await aP;
      const bP = client.root.get();
      await flush();
      const b = await bP;
      expect(a).toBe(b);
    });

    it('nested markers inside plain-object slots survive', async () => {
      const Inner = createModel<{
        v: ReturnType<typeof signal<number>>;
      }>('Inner', () => {
        const v = signal(7);
        return {v};
      });
      const root = {
        bundle() {
          return {
            meta: {version: 1},
            wrapper: {nested: new Inner()},
          };
        },
      };
      const rpc = new RPC(root);
      const {client, flush} = connect(rpc, mode, 'c1');
      await flush();
      await client.ready;

      const p = client.root.bundle();
      await flush();
      const result = await p;
      expect(result.meta.version).toBe(1);
      expect(typeOfRemote(result.wrapper.nested)).toBe('Inner');
      expect(result.wrapper.nested.v.peek()).toBe(7);
    });
  });
}
