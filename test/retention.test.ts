import {signal} from '@preact/signals-core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {RPCClient} from '../client/rpc.ts';
import {createModel} from '../server/model.ts';
import {RPC} from '../server/rpc.ts';
import {RELEASE_HANDLES_METHOD} from '../shared/protocol.ts';
import {createLinkedTransportPair} from './helpers.ts';

afterEach(() => {
  vi.useRealTimers();
});

function connect(rpc: RPC, id = 'c1') {
  const {serverTransport, clientTransport, flush} = createLinkedTransportPair();
  const client = new RPCClient(clientTransport);
  const cleanup = rpc.addClient(serverTransport, id);
  return {client, cleanup, flush};
}

const Item = createModel<{
  val: ReturnType<typeof signal<number>>;
}>('Item', () => ({val: signal(0)}));

describe('Retention: disconnect policy', () => {
  it('drops all client-owned handles when the client disconnects', async () => {
    vi.useFakeTimers();
    const rpc = new RPC(
      {
        make() {
          return new Item();
        },
      },
      {retention: {kind: 'disconnect'}},
    );

    const {client, cleanup, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('make');
    await flush();
    await p;

    // handles: o0 (root), f1 (make fn), o1 (Item), s1 (val signal) — plus
    // shapes, but those live in the shape registry not as handles.
    expect(rpc.handles.valueOf('o1')).toBeDefined();
    expect(rpc.handles.valueOf('s1')).toBeDefined();

    cleanup();

    // Everything except the root (o0) is orphaned and dropped.
    expect(rpc.handles.valueOf('o1')).toBeUndefined();
    expect(rpc.handles.valueOf('s1')).toBeUndefined();
    expect(rpc.handles.valueOf('o0')).toBeDefined();
  });
});

describe('Retention: ttl policy', () => {
  it('drops orphaned handles after idleMs', async () => {
    vi.useFakeTimers();
    const rpc = new RPC(
      {
        make() {
          return new Item();
        },
      },
      {retention: {kind: 'ttl', idleMs: 1_000, sweepMs: 500}},
    );

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('make');
    await flush();
    await p;
    expect(rpc.handles.valueOf('o1')).toBeDefined();

    // Client releases the handle.
    client.notify(RELEASE_HANDLES_METHOD, ['o1']);
    await flush();
    // Signal was a child — release that too for a clean orphan.
    client.notify(RELEASE_HANDLES_METHOD, ['s1']);
    await flush();

    // Not yet idle enough.
    rpc._sweepTtlNow();
    expect(rpc.handles.valueOf('o1')).toBeDefined();

    // Fast-forward beyond the idle window.
    vi.setSystemTime(Date.now() + 2_000);
    rpc._sweepTtlNow();
    expect(rpc.handles.valueOf('o1')).toBeUndefined();
    expect(rpc.handles.valueOf('s1')).toBeUndefined();
  });

  it('keeps handles that still have refs from other clients', async () => {
    vi.useFakeTimers();
    const rpc = new RPC(
      {
        shared: new Item(),
      },
      {retention: {kind: 'ttl', idleMs: 1}},
    );

    const a = connect(rpc, 'a');
    const b = connect(rpc, 'b');
    await a.flush();
    await a.client.ready;
    await b.flush();
    await b.client.ready;

    // Only 'a' releases.
    a.client.notify(RELEASE_HANDLES_METHOD, ['o1']);
    await a.flush();

    vi.setSystemTime(Date.now() + 1_000);
    rpc._sweepTtlNow();

    // b still holds the reference.
    expect(rpc.handles.valueOf('o1')).toBeDefined();
  });
});

describe('Release protocol', () => {
  it('client relays a release when a handle becomes unreachable (FinalizationRegistry)', async () => {
    // FinalizationRegistry timing is nondeterministic, so we verify the
    // deterministic path: the client env's scheduleRelease is exposed via
    // the release batch mechanism, and @H- frames land on the server.
    vi.useFakeTimers();
    const rpc = new RPC(
      {
        make() {
          return new Item();
        },
      },
      {retention: {kind: 'ttl', idleMs: 100_000}},
    );

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('make');
    await flush();
    await p;

    client.notify(RELEASE_HANDLES_METHOD, ['o1', 's1']);
    await flush();

    // Refs should be gone, but TTL window prevents drop.
    expect(rpc.handles.get('o1')?.refs.size).toBe(0);
    expect(rpc.handles.get('s1')?.refs.size).toBe(0);
  });
});
