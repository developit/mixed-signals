/**
 * Regression tests for the round-1 critical / important findings
 * against `enableSyncServer`:
 *
 *   - Caller-timeout-and-retry no longer leaks a suspended
 *     `serviceSyncRequest` async frame on the host. The
 *     `BatchContext` refactor aborts the prior batch when a new
 *     doorbell arrives, so the second batch completes cleanly.
 *
 *   - The request-side `Atomics.wait` honours `timeoutMs`. A host
 *     that stalls between MORE_REQ acks no longer wedges the worker
 *     forever; `SyncRPCTimeoutError` fires within the budget.
 *
 * The host-side leak isn't directly observable from outside (it's a
 * memory + suspended-frame leak), so we exercise the structural
 * property: after a timeout-and-retry sequence, a subsequent batch
 * completes correctly. Before the fix this would hang because the
 * prior `await allDone` in `serviceSyncRequest` had been orphaned by
 * module-scope state overwriting.
 */
import {Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {RPC} from '../../server/rpc.ts';
import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../../shared/protocol.ts';
import {enableSyncServer} from '../../sync/server.ts';

const WORKER_URL = new URL('./_real-caller-fixture.ts', import.meta.url);

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

describe('enableSyncServer — caller timeout + retry sequence', () => {
  let h: Harness | undefined;

  beforeEach(() => {
    h = undefined;
  });

  afterEach(async () => {
    if (h) await h.dispose();
    h = undefined;
  });

  it('a second batch succeeds after a caller-side timeout on the first', async () => {
    // The root provides a method that never resolves (the first
    // call) and a method that returns a value (the retry). Before
    // the BatchContext refactor, the second call would hang because
    // the prior `serviceSyncRequest` frame had orphaned the new
    // batch's resolve handle.
    h = setupHarness({
      hang() {
        return new Promise(() => {
          /* never resolves */
        });
      },
      add(a: number, b: number) {
        return a + b;
      },
    });

    // First batch: times out at the caller. The host enters
    // `serviceSyncRequest` and awaits forever; on caller timeout we
    // expect SyncRPCTimeoutError back to the test harness.
    const firstThrew = await h.cmd<{
      type: 'wait-batch-throw-result';
      errorName: string;
    }>({
      type: 'wait-batch-expect-throw',
      calls: [{type: 'call', id: 1_000_000, method: 'hang', params: []}],
      timeoutMs: 50,
    });
    expect(firstThrew.errorName).toBe('SyncRPCTimeoutError');

    // Second batch: must succeed. Before the fix this hung because
    // the prior batch's module-scope state was clobbered by the
    // retry, leaving the prior batch's `await allDone` permanently
    // unresolved and the retry's `serviceSyncRequest` frame writing
    // into already-overwritten state. After the fix, the new
    // doorbell aborts the prior batch (sets aborted=true, resolves
    // its done), the prior frame bails without publishing, and the
    // new batch's context is fresh.
    const second = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{type: 'call', id: 1_000_001, method: 'add', params: [2, 3]}],
      timeoutMs: 1000,
    });
    expect(
      (second.results[0] as Extract<WireMessage, {type: 'result'}>).value,
    ).toBe(5);
  });
});

describe('enableSyncServer — pull-from-aborted-batch must not write into SAB', () => {
  // Architectural race surfaced during validation: a stale `pull` for
  // an aborted batch would race against the new batch's request bytes
  // in the data SAB. The fix gates `writeNextResponseChunk(seq)` by
  // `activeBatch.seq === seq`. Full multi-chunk-response timing race
  // is hard to reproduce deterministically across the Node worker
  // boundary; this test exercises the adjacent structural property
  // — a sequence of independent batches each gets the right response
  // — which a missing or over-restrictive gate would break.
  let h2: Harness | undefined;
  afterEach(async () => {
    if (h2) await h2.dispose();
    h2 = undefined;
  });

  it('five back-to-back single-call batches each return their own value', async () => {
    h2 = setupHarness({
      echo<T>(v: T) {
        return v;
      },
    });
    for (let i = 0; i < 5; i++) {
      const result = await h2.cmd<{results: WireMessage[]}>({
        type: 'wait-batch',
        calls: [
          {type: 'call', id: 1_000_000 + i, method: 'echo', params: [i]},
        ],
        timeoutMs: 1000,
      });
      expect(
        (result.results[0] as Extract<WireMessage, {type: 'result'}>).value,
      ).toBe(i);
    }
  });
});
