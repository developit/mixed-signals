import {signal} from '@preact/signals-core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {RPCClient} from '../client/rpc.ts';
import {decode, encode} from '../codecs/index.ts';
import {createModel} from '../server/model.ts';
import {RPC} from '../server/rpc.ts';
import type {
  RawTransport,
  StringTransport,
  Transport,
} from '../shared/protocol.ts';
import {
  createLinkedRawTransportPair,
  createLinkedTransportPair,
  flush as tick,
} from './helpers.ts';

/**
 * End-to-end tests: a full RPC round-trip through both string and raw
 * transports with the default codecs registered via `transport.encode` /
 * `transport.decode`. Rich types (Map, Set, TypedArray, Date, BigInt, …)
 * must round-trip with structural and instanceof fidelity.
 */

type Mode = 'string' | 'raw';

function makePair(mode: Mode) {
  if (mode === 'string') {
    const {serverTransport, clientTransport, flush} = createLinkedTransportPair();
    return {serverTransport, clientTransport, flush};
  }
  const {serverTransport, clientTransport, flush} =
    createLinkedRawTransportPair();
  return {serverTransport, clientTransport, flush};
}

function withCodecs(transport: Transport): Transport {
  const t = transport as StringTransport | RawTransport;
  (t as {encode?: unknown}).encode = encode;
  (t as {decode?: unknown}).decode = decode;
  return t as Transport;
}

for (const mode of ['string', 'raw'] as const) {
  describe(`Type codecs over ${mode} transport`, () => {
    afterEach(() => vi.useRealTimers());

    it('Map with primitive values', async () => {
      const root = {
        getMap() {
          return new Map<string, number>([
            ['a', 1],
            ['b', 2],
            ['c', 3],
          ]);
        },
      };
      const rpc = new RPC(root);
      const {serverTransport, clientTransport, flush} = makePair(mode);
      withCodecs(serverTransport);
      withCodecs(clientTransport);
      const client = new RPCClient(clientTransport);
      rpc.addClient(serverTransport, 'c1');
      await flush();
      await client.ready;

      const p = client.root.getMap();
      await flush();
      const result = (await p) as Map<string, number>;
      expect(result).toBeInstanceOf(Map);
      expect([...result.entries()]).toEqual([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]);
    });

    it('Set of strings', async () => {
      const root = {
        getTags() {
          return new Set(['new', 'sale', 'featured']);
        },
      };
      const rpc = new RPC(root);
      const {serverTransport, clientTransport, flush} = makePair(mode);
      withCodecs(serverTransport);
      withCodecs(clientTransport);
      const client = new RPCClient(clientTransport);
      rpc.addClient(serverTransport, 'c1');
      await flush();
      await client.ready;

      const p = client.root.getTags();
      await flush();
      const result = (await p) as Set<string>;
      expect(result).toBeInstanceOf(Set);
      expect([...result]).toEqual(['new', 'sale', 'featured']);
    });

    it('Uint8Array preserves constructor and bytes', async () => {
      const root = {
        getBytes() {
          return new Uint8Array([1, 2, 3, 4, 5]);
        },
      };
      const rpc = new RPC(root);
      const {serverTransport, clientTransport, flush} = makePair(mode);
      withCodecs(serverTransport);
      withCodecs(clientTransport);
      const client = new RPCClient(clientTransport);
      rpc.addClient(serverTransport, 'c1');
      await flush();
      await client.ready;

      const p = client.root.getBytes();
      await flush();
      const result = (await p) as Uint8Array;
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
    });

    it('Float32Array via consolidated typed-array codec', async () => {
      const root = {
        getFloats() {
          return new Float32Array([1.5, -2.25, 3.125]);
        },
      };
      const rpc = new RPC(root);
      const {serverTransport, clientTransport, flush} = makePair(mode);
      withCodecs(serverTransport);
      withCodecs(clientTransport);
      const client = new RPCClient(clientTransport);
      rpc.addClient(serverTransport, 'c1');
      await flush();
      await client.ready;

      const p = client.root.getFloats();
      await flush();
      const result = (await p) as Float32Array;
      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(3);
      expect(result[0]).toBeCloseTo(1.5);
      expect(result[1]).toBeCloseTo(-2.25);
      expect(result[2]).toBeCloseTo(3.125);
    });

    it('BigInt', async () => {
      const root = {
        getBig() {
          return 12345678901234567890n;
        },
      };
      const rpc = new RPC(root);
      const {serverTransport, clientTransport, flush} = makePair(mode);
      withCodecs(serverTransport);
      withCodecs(clientTransport);
      const client = new RPCClient(clientTransport);
      rpc.addClient(serverTransport, 'c1');
      await flush();
      await client.ready;

      const p = client.root.getBig();
      await flush();
      const result = await p;
      expect(result).toBe(12345678901234567890n);
    });

    it('client can send a Map as a method argument', async () => {
      let received: unknown;
      const root = {
        accept(m: unknown) {
          received = m;
          return 'ok';
        },
      };
      const rpc = new RPC(root);
      const {serverTransport, clientTransport, flush} = makePair(mode);
      withCodecs(serverTransport);
      withCodecs(clientTransport);
      const client = new RPCClient(clientTransport);
      rpc.addClient(serverTransport, 'c1');
      await flush();
      await client.ready;

      const p = client.root.accept(
        new Map([
          ['x', 1],
          ['y', 2],
        ]),
      );
      await flush();
      await p;
      expect(received).toBeInstanceOf(Map);
      expect([...(received as Map<string, number>).entries()]).toEqual([
        ['x', 1],
        ['y', 2],
      ]);
    });

    it('@H + @T compose: Map containing a live Signal', async () => {
      const Counter = createModel<{
        v: ReturnType<typeof signal<number>>;
      }>('Counter', () => {
        const v = signal(7);
        return {v};
      });
      const c1 = new Counter();
      const root = {
        tagged() {
          return new Map<string, unknown>([
            ['label', 'hello'],
            ['counter', c1],
          ]);
        },
      };
      const rpc = new RPC(root);
      const {serverTransport, clientTransport, flush} = makePair(mode);
      withCodecs(serverTransport);
      withCodecs(clientTransport);
      const client = new RPCClient(clientTransport);
      rpc.addClient(serverTransport, 'c1');
      await flush();
      await client.ready;

      const p = client.root.tagged();
      await flush();
      const result = (await p) as Map<string, unknown>;
      expect(result).toBeInstanceOf(Map);
      expect(result.get('label')).toBe('hello');
      const cProxy = result.get('counter') as {v: {peek(): number}};
      expect(cProxy.v.peek()).toBe(7);
    });

    it('RegExp', async () => {
      const root = {
        pattern() {
          return /[a-z]+/giu;
        },
      };
      const rpc = new RPC(root);
      const {serverTransport, clientTransport, flush} = makePair(mode);
      withCodecs(serverTransport);
      withCodecs(clientTransport);
      const client = new RPCClient(clientTransport);
      rpc.addClient(serverTransport, 'c1');
      await flush();
      await client.ready;

      const p = client.root.pattern();
      await flush();
      const result = (await p) as RegExp;
      expect(result).toBeInstanceOf(RegExp);
      expect(result.source).toBe('[a-z]+');
      expect(result.flags).toBe('giu');
    });

    it('nested rich types: Map<string, Set<Uint8Array>>', async () => {
      const root = {
        nested() {
          return new Map<string, Set<Uint8Array>>([
            ['a', new Set([new Uint8Array([1, 2]), new Uint8Array([3, 4])])],
            ['b', new Set([new Uint8Array([5, 6])])],
          ]);
        },
      };
      const rpc = new RPC(root);
      const {serverTransport, clientTransport, flush} = makePair(mode);
      withCodecs(serverTransport);
      withCodecs(clientTransport);
      const client = new RPCClient(clientTransport);
      rpc.addClient(serverTransport, 'c1');
      await flush();
      await client.ready;

      const p = client.root.nested();
      await flush();
      const result = (await p) as Map<string, Set<Uint8Array>>;
      expect(result).toBeInstanceOf(Map);
      const a = result.get('a');
      expect(a).toBeInstanceOf(Set);
      const members = [...(a as Set<Uint8Array>)];
      expect(members[0]).toBeInstanceOf(Uint8Array);
      expect(Array.from(members[0])).toEqual([1, 2]);
      expect(Array.from(members[1])).toEqual([3, 4]);
    });
  });
}

describe('Serializer regression: built-ins are not mis-upgraded to @H', () => {
  it('Uint8Array returned from a method lands as Uint8Array on the other side (with codecs)', async () => {
    const root = {
      bytes() {
        return new Uint8Array([9, 9, 9]);
      },
    };
    const rpc = new RPC(root);
    const {serverTransport, clientTransport, flush} = createLinkedTransportPair();
    // With codecs registered — should land as Uint8Array.
    (serverTransport as StringTransport).encode = encode;
    (serverTransport as StringTransport).decode = decode;
    (clientTransport as StringTransport).encode = encode;
    (clientTransport as StringTransport).decode = decode;

    const client = new RPCClient(clientTransport);
    rpc.addClient(serverTransport, 'c1');
    await flush();
    await client.ready;

    const p = client.root.bytes();
    await flush();
    const result = await p;
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result as Uint8Array)).toEqual([9, 9, 9]);
  });

  it('Map without codecs over string transport: degrades gracefully, does not become an @H handle', async () => {
    const root = {
      getMap() {
        return new Map([['a', 1]]);
      },
    };
    const rpc = new RPC(root);
    const {serverTransport, clientTransport, flush} = createLinkedTransportPair();
    const client = new RPCClient(clientTransport);
    rpc.addClient(serverTransport, 'c1');
    await flush();
    await client.ready;

    const p = client.root.getMap();
    await flush();
    const result = await p;
    // Without a codec, the Map becomes `{}` on the wire (JSON.stringify's
    // default Map behavior). The critical invariant is that it didn't get
    // upgraded to an `@H` handle — no method calls try to dispatch on it.
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('@H');
    expect(typeof (result as any).get).toBe('undefined'); // not a live Map proxy
  });
});
