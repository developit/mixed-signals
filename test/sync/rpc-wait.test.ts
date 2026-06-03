/**
 * `RPCClient.wait()` and `canWait()` integration tests.
 *
 * Drive sync calls end-to-end against a real `RPC` server via the
 * `enableSyncServer` / `enableSyncClient` pair, using a Node
 * `worker_threads` Worker as the caller side. The host-side
 * assertions verify:
 *
 *   - Primitive return-values round-trip identically to the async
 *     path.
 *   - Handles returned through `rpc.wait` hydrate as proxies
 *     equivalent to the async path's proxies (same brand semantics).
 *   - N-arity batches return three results in input order.
 *   - Already-consumed promises throw `SyncRPCAlreadyWaitedError`.
 *   - Non-sync transports throw `SyncRPCNoTransportWaitError`.
 *   - Empty batches throw `RangeError`.
 *   - First-error-wins on N-arity batches with mixed success/failure.
 */
import {Worker} from 'node:worker_threads';
import {signal} from '@preact/signals-core';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {RPCClient} from '../../client/rpc.ts';
import {createRawMemoryTransportPair} from '../../server/memory-transport.ts';
import {createModel} from '../../server/model.ts';
import {RPC} from '../../server/rpc.ts';
import type {
  RawTransport,
  TransportContext,
} from '../../shared/protocol.ts';
import {SyncRPCNoTransportWaitError} from '../../sync/errors.ts';
import {enableSyncServer} from '../../sync/server.ts';

const WORKER_URL = new URL('./_rpc-wait-fixture.ts', import.meta.url);

interface Harness {
  worker: Worker;
  rpc: RPC;
  cmd: <T = unknown>(command: {
    type: string;
    [k: string]: unknown;
  }) => Promise<T>;
  dispose: () => Promise<void>;
}

function setupHarness(root: object): Harness {
  const worker = new Worker(WORKER_URL);
  worker.on('error', (err: Error) => {
    // eslint-disable-next-line no-console
    console.error('[worker error]', err);
  });

  const rpcListeners: Array<
    (data: unknown, ctx?: TransportContext) => void | Promise<void>
  > = [];
  const testListeners: Array<(data: unknown) => void> = [];

  worker.on('message', (envelope: {kind: string; data: unknown}) => {
    if (envelope?.kind === 'mixed-signals') {
      for (const listener of rpcListeners) listener(envelope.data);
    } else if (envelope?.kind === 'test') {
      for (const listener of testListeners) listener(envelope.data);
    }
  });

  const base: RawTransport = {
    mode: 'raw',
    send(data, _ctx) {
      worker.postMessage({kind: 'mixed-signals', data});
    },
    onMessage(cb) {
      rpcListeners.push(cb);
    },
  };

  const wrapped = enableSyncServer(base);
  const rpc = new RPC(root);
  rpc.addClient(wrapped);

  let nextId = 1;
  const readyPromise = new Promise<void>((resolve, reject) => {
    testListeners.push((msg: unknown) => {
      const m = msg as {type: string; error?: string};
      if (m.type === 'ready') resolve();
      if (m.type === 'fatal') {
        reject(new Error(`worker fatal: ${m.error ?? '(no message)'}`));
      }
    });
  });

  function cmd<T>(command: {
    type: string;
    [k: string]: unknown;
  }): Promise<T> {
    const id = nextId++;
    return readyPromise.then(
      () =>
        new Promise<T>((resolve, reject) => {
          const listener = (msg: unknown) => {
            const m = msg as {
              type: string;
              id?: number;
              ok?: boolean;
              error?: string;
            };
            if (m.id !== id) return;
            const idx = testListeners.indexOf(listener);
            if (idx >= 0) testListeners.splice(idx, 1);
            if (m.ok === false) {
              reject(new Error(m.error ?? '(no error message)'));
            } else {
              resolve(m as T);
            }
          };
          testListeners.push(listener);
          worker.postMessage({kind: 'test', data: {...command, id}});
        }),
    );
  }

  return {
    worker,
    rpc,
    cmd,
    dispose: async () => {
      await worker.terminate();
    },
  };
}

describe('RPCClient.canWait', () => {
  it('returns false when the transport does not implement wait?', () => {
    const [serverT, clientT] = createRawMemoryTransportPair();
    // Construct RPCClient before adding the server so the client is
    // subscribed when `@R` flies (otherwise it's silently dropped).
    const client = new RPCClient(clientT);
    const rpc = new RPC({});
    rpc.addClient(serverT);
    expect(client.canWait()).toBe(false);
    rpc.close();
  });
});

describe('RPCClient.wait — non-sync transports', () => {
  it('throws SyncRPCNoTransportWaitError when transport has no wait?', async () => {
    const [serverT, clientT] = createRawMemoryTransportPair();
    const client = new RPCClient(clientT);
    const rpc = new RPC({
      hello() {
        return 'world';
      },
    });
    rpc.addClient(serverT);
    await client.ready;

    expect(() => {
      // The proxy method returns a SyncablePromise, so this is the
      // shape `wait` expects; the missing `wait?` should still throw
      // before the promise is claimed.
      client.wait([client.root.hello()]);
    }).toThrow(SyncRPCNoTransportWaitError);

    rpc.close();
  });

  it('throws RangeError on an empty promises array', () => {
    const [serverT, clientT] = createRawMemoryTransportPair();
    // Inject a fake `wait?` so the no-transport guard passes and we
    // reach the empty-array check.
    const clientTransport: typeof clientT = {
      ...clientT,
      wait() {
        return [];
      },
    };
    const client = new RPCClient(clientTransport);
    const rpc = new RPC({});
    rpc.addClient(serverT);
    expect(() => client.wait([])).toThrow(RangeError);
    rpc.close();
  });
});

describe('RPCClient.wait — end-to-end via Node worker', () => {
  let h: Harness | undefined;

  beforeEach(() => {
    h = undefined;
  });

  afterEach(async () => {
    if (h) await h.dispose();
    h = undefined;
  });

  it('round-trips a primitive return value', async () => {
    h = setupHarness({
      add(a: number, b: number) {
        return a + b;
      },
    });

    const result = await h.cmd<{value: number}>({
      type: 'sync-call',
      method: 'add',
      args: [2, 3],
    });
    expect(result.value).toBe(5);
  });

  it('three primitive-returning calls in one rpc.wait round-trip return three correct results in input order', async () => {
    h = setupHarness({
      one() {
        return 1;
      },
      two() {
        return 'two';
      },
      three() {
        return true;
      },
    });

    const result = await h.cmd<{values: unknown[]}>({
      type: 'sync-batch',
      calls: [
        {method: 'one', args: []},
        {method: 'two', args: []},
        {method: 'three', args: []},
      ],
    });
    expect(result.values).toEqual([1, 'two', true]);
  });

  it('hydrates a handle return value as a proxy (same brand semantics as async path)', async () => {
    const Counter = createModel<{value: ReturnType<typeof signal<number>>}>(
      'WaitCounter',
      () => ({value: signal(7)}),
    );
    h = setupHarness({
      makeCounter() {
        return new Counter();
      },
    });

    const result = await h.cmd<{typeName: string; valueOfValue: number}>({
      type: 'sync-call-handle',
      method: 'makeCounter',
    });
    expect(result.typeName).toBe('WaitCounter');
    expect(result.valueOfValue).toBe(7);
  });

  it('throws SyncRPCAlreadyWaitedError when given an already-awaited promise', async () => {
    h = setupHarness({
      ping() {
        return 'pong';
      },
    });

    const result = await h.cmd<{errorName: string}>({
      type: 'reuse-await-then-wait',
    });
    expect(result.errorName).toBe('SyncRPCAlreadyWaitedError');
  });

  it('throws SyncRPCAlreadyWaitedError when given a plain Promise (not a SyncablePromise)', async () => {
    h = setupHarness({});
    const result = await h.cmd<{errorName: string}>({type: 'wait-plain-promise'});
    expect(result.errorName).toBe('SyncRPCAlreadyWaitedError');
  });

  it('first-error-wins on a batch with one failure', async () => {
    h = setupHarness({
      ok() {
        return 'fine';
      },
      bad() {
        throw new Error('detonated');
      },
    });

    const result = await h.cmd<{errorMessage: string}>({
      type: 'sync-batch-expect-throw',
      calls: [
        {method: 'ok', args: []},
        {method: 'bad', args: []},
        {method: 'ok', args: []},
      ],
    });
    expect(result.errorMessage).toBe('detonated');
  });
});
