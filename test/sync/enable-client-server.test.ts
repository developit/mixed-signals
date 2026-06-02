/**
 * End-to-end integration tests pairing `enableSyncClient` (caller
 * side, running in a Node `worker_threads` Worker) with
 * `enableSyncServer` (host side, running on the test's main thread).
 * Validates the full SAB protocol round trip with both production
 * wrappers in the loop — the acceptance criterion the host-issue's
 * summary calls out as "uses M001I003T's caller wrapper".
 */
import {Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {RPC} from '../../server/rpc.ts';
import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../../shared/protocol.ts';
import {MIN_DATA_SAB_BYTES} from '../../sync/lane.ts';
import {enableSyncServer} from '../../sync/server.ts';

const WORKER_URL = new URL('./_real-caller-fixture.ts', import.meta.url);

interface Harness {
  worker: Worker;
  rpc: RPC;
  cmd: <T = unknown>(command: {type: string; [k: string]: unknown}) => Promise<T>;
  dispose: () => Promise<void>;
}

function setupHarness(
  root: object,
  opts: {dataSabSize?: number} = {},
): Harness {
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

  const wrapped = enableSyncServer(base, {dataSabSize: opts.dataSabSize});
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

describe('enableSyncClient + enableSyncServer integration', () => {
  let h: Harness | undefined;

  beforeEach(() => {
    h = undefined;
  });

  afterEach(async () => {
    if (h) await h.dispose();
    h = undefined;
  });

  it('round-trips a no-op method via rpc.wait', async () => {
    h = setupHarness({
      ping() {
        return 'pong';
      },
    });

    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [
        {type: 'call', id: 1_000_000, method: 'ping', params: []},
      ],
    });
    expect(
      (results[0] as Extract<WireMessage, {type: 'result'}>).value,
    ).toBe('pong');
  });

  it('round-trips a method with arguments and a primitive return', async () => {
    h = setupHarness({
      mul(a: number, b: number) {
        return a * b;
      },
    });

    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [
        {type: 'call', id: 1_000_000, method: 'mul', params: [6, 7]},
      ],
    });
    expect(
      (results[0] as Extract<WireMessage, {type: 'result'}>).value,
    ).toBe(42);
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

    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [
        {type: 'call', id: 1_000_000, method: 'one', params: []},
        {type: 'call', id: 1_000_001, method: 'two', params: []},
        {type: 'call', id: 1_000_002, method: 'three', params: []},
      ],
    });
    expect(results).toHaveLength(3);
    expect(
      results.map(
        (m) => (m as Extract<WireMessage, {type: 'result'}>).value,
      ),
    ).toEqual([1, 'two', true]);
  });

  it('captures errors from methods that throw and reports them as error frames', async () => {
    h = setupHarness({
      boom() {
        throw new Error('detonated');
      },
    });
    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [
        {type: 'call', id: 1_000_000, method: 'boom', params: []},
      ],
    });
    expect(results[0]?.type).toBe('error');
    expect(
      (results[0] as Extract<WireMessage, {type: 'error'}>).value,
    ).toMatchObject({message: 'detonated'});
  });

  it('round-trips a request envelope ~5× the data SAB through chunking', async () => {
    h = setupHarness(
      {
        echoLen(s: string) {
          return s.length;
        },
      },
      {dataSabSize: MIN_DATA_SAB_BYTES},
    );

    const arg = 'x'.repeat(MIN_DATA_SAB_BYTES * 5);
    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [
        {type: 'call', id: 1_000_000, method: 'echoLen', params: [arg]},
      ],
    });
    expect(
      (results[0] as Extract<WireMessage, {type: 'result'}>).value,
    ).toBe(MIN_DATA_SAB_BYTES * 5);
  });

  it('round-trips a response envelope ~5× the data SAB through chunking', async () => {
    h = setupHarness(
      {
        bigString(n: number) {
          return 'y'.repeat(n);
        },
      },
      {dataSabSize: MIN_DATA_SAB_BYTES},
    );

    const n = MIN_DATA_SAB_BYTES * 5;
    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [
        {type: 'call', id: 1_000_000, method: 'bigString', params: [n]},
      ],
    });
    const value = (results[0] as Extract<WireMessage, {type: 'result'}>)
      .value as string;
    expect(value.length).toBe(n);
  });

  it('subsequent sync batches succeed after a prior batch (caller state cleanly resets)', async () => {
    h = setupHarness({
      identity<T>(v: T) {
        return v;
      },
    });

    const first = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [
        {type: 'call', id: 1_000_000, method: 'identity', params: ['first']},
      ],
    });
    expect(
      (first.results[0] as Extract<WireMessage, {type: 'result'}>).value,
    ).toBe('first');

    const second = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [
        {type: 'call', id: 1_000_001, method: 'identity', params: ['second']},
      ],
    });
    expect(
      (second.results[0] as Extract<WireMessage, {type: 'result'}>).value,
    ).toBe('second');
  });

  it('throws SyncRPCTimeoutError if the host never responds within timeoutMs', async () => {
    // Method never returns — the caller's wait() should time out.
    h = setupHarness({
      hang() {
        return new Promise(() => {
          /* never resolves */
        });
      },
    });

    const result = await h.cmd<{
      type: 'wait-batch-throw-result';
      errorName: string;
      errorMessage: string;
    }>({
      type: 'wait-batch-expect-throw',
      calls: [
        {type: 'call', id: 1_000_000, method: 'hang', params: []},
      ],
      timeoutMs: 50,
    });
    expect(result.errorName).toBe('SyncRPCTimeoutError');
    expect(result.errorMessage).toMatch(/timed out/);
  });
});
