import {Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {RPC} from '../../server/rpc.ts';
import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../../shared/protocol.ts';
import {
  CONTROL_SAB_BYTES,
  DEFAULT_DATA_SAB_BYTES,
  MIN_DATA_SAB_BYTES,
} from '../../sync/lane.ts';
import {enableSyncServer} from '../../sync/server.ts';

const WORKER_URL = new URL('./_caller-fixture.ts', import.meta.url);

interface Harness {
  worker: Worker;
  rpc: RPC;
  /** Send a test-driver command and wait for the matching response. */
  cmd: <T = unknown>(command: {type: string; [k: string]: unknown}) => Promise<T>;
  /** Direct access to the host-side base transport (for spying). */
  base: RawTransport;
  /** Outbound payloads observed on the host's base transport. */
  baseSent: unknown[];
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

  // Multiplexed listener: routes RPC envelopes to the host transport's
  // onMessage callback and test envelopes to the per-command waiter.
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

  const baseSent: unknown[] = [];
  const base: RawTransport = {
    mode: 'raw',
    send(data, _ctx) {
      baseSent.push(data);
      worker.postMessage({kind: 'mixed-signals', data});
    },
    onMessage(cb) {
      rpcListeners.push(cb);
    },
  };

  const wrapped = enableSyncServer(base, {
    dataSabSize: opts.dataSabSize,
  });
  const rpc = new RPC(root);
  rpc.addClient(wrapped);

  let nextId = 1;
  // Wait for the worker fixture to signal readiness before resolving
  // any commands.
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
    base,
    baseSent,
    dispose: async () => {
      await worker.terminate();
    },
  };
}

describe('enableSyncServer', () => {
  let h: Harness | undefined;

  beforeEach(() => {
    h = undefined;
  });

  afterEach(async () => {
    if (h) await h.dispose();
    h = undefined;
  });

  it('handshake allocates SABs of the configured sizes', async () => {
    h = setupHarness({}, {dataSabSize: 8192});
    const result = await h.cmd<{
      type: 'handshake-result';
      controlBytes: number;
      dataBytes: number;
    }>({type: 'handshake'});
    expect(result.controlBytes).toBe(CONTROL_SAB_BYTES);
    expect(result.dataBytes).toBe(8192);
  });

  it('handshake defaults to DEFAULT_DATA_SAB_BYTES when no opts.dataSabSize', async () => {
    h = setupHarness({});
    const result = await h.cmd<{
      type: 'handshake-result';
      dataBytes: number;
    }>({type: 'handshake'});
    expect(result.dataBytes).toBe(DEFAULT_DATA_SAB_BYTES);
  });

  it('single-chunk single-call (no args, primitive return) round-trips', async () => {
    h = setupHarness({
      now() {
        return 1700000000000;
      },
    });
    await h.cmd({type: 'handshake'});

    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{method: 'now'}],
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe('result');
    expect((results[0] as Extract<WireMessage, {type: 'result'}>).value).toBe(
      1700000000000,
    );
  });

  it('single-chunk single-call with args returns the right value', async () => {
    h = setupHarness({
      add(a: number, b: number) {
        return a + b;
      },
    });
    await h.cmd({type: 'handshake'});

    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{method: 'add', params: [3, 4]}],
    });
    expect((results[0] as Extract<WireMessage, {type: 'result'}>).value).toBe(
      7,
    );
  });

  it('N-arity batch returns three results in input order', async () => {
    h = setupHarness({
      one() {
        return 1;
      },
      two() {
        return 2;
      },
      three() {
        return 3;
      },
    });
    await h.cmd({type: 'handshake'});

    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{method: 'one'}, {method: 'two'}, {method: 'three'}],
    });
    expect(results).toHaveLength(3);
    expect(
      results.map(
        (m) => (m as Extract<WireMessage, {type: 'result'}>).value,
      ),
    ).toEqual([1, 2, 3]);
  });

  it('captures errors from methods that throw', async () => {
    h = setupHarness({
      boom() {
        throw new Error('kaboom');
      },
    });
    await h.cmd({type: 'handshake'});

    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{method: 'boom'}],
    });
    expect(results[0]?.type).toBe('error');
    expect(
      (results[0] as Extract<WireMessage, {type: 'error'}>).value,
    ).toMatchObject({message: 'kaboom'});
  });

  it('empty batch returns an empty results array immediately', async () => {
    h = setupHarness({});
    await h.cmd({type: 'handshake'});

    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [],
    });
    expect(results).toEqual([]);
  });

  it('handles a multi-chunk request (envelope larger than data SAB)', async () => {
    h = setupHarness(
      {
        echoLen(s: string) {
          return s.length;
        },
      },
      {dataSabSize: MIN_DATA_SAB_BYTES},
    );
    await h.cmd({type: 'handshake'});

    // 5× the data SAB ensures the envelope chunks across at least 5
    // doorbells. JSON framing adds ~50 bytes; the string arg dominates.
    const arg = 'x'.repeat(MIN_DATA_SAB_BYTES * 5);
    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{method: 'echoLen', params: [arg]}],
    });
    expect(
      (results[0] as Extract<WireMessage, {type: 'result'}>).value,
    ).toBe(MIN_DATA_SAB_BYTES * 5);
  });

  it('handles a multi-chunk response (return value larger than data SAB)', async () => {
    h = setupHarness(
      {
        bigString(n: number) {
          return 'y'.repeat(n);
        },
      },
      {dataSabSize: MIN_DATA_SAB_BYTES},
    );
    await h.cmd({type: 'handshake'});

    const n = MIN_DATA_SAB_BYTES * 5;
    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{method: 'bigString', params: [n]}],
    });
    const value = (results[0] as Extract<WireMessage, {type: 'result'}>)
      .value as string;
    expect(value.length).toBe(n);
    expect(value).toBe('y'.repeat(n));
  });

  it('handles multi-chunk both ways in one batch', async () => {
    h = setupHarness(
      {
        echo(s: string) {
          return s;
        },
      },
      {dataSabSize: MIN_DATA_SAB_BYTES},
    );
    await h.cmd({type: 'handshake'});

    const payload = 'z'.repeat(MIN_DATA_SAB_BYTES * 5);
    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{method: 'echo', params: [payload]}],
    });
    expect(
      (results[0] as Extract<WireMessage, {type: 'result'}>).value,
    ).toBe(payload);
  });

  it('re-handshake reuses the existing SAB pair (shared memory preserved)', async () => {
    // SAB wrappers don't survive postMessage as `===` references in
    // Node — each cross-boundary trip creates a fresh wrapper around
    // the same shared memory. So we verify reuse by writing a
    // sentinel into the control SAB before the re-handshake and
    // checking it survives. If the host had allocated fresh,
    // `allocateLane` would have reset LANE_VERSION to 1 — overwriting
    // our sentinel.
    h = setupHarness({});
    await h.cmd({type: 'handshake'});
    const result = await h.cmd<{
      type: 'rehandshake-result';
      sentinelMatches: boolean;
    }>({type: 'rehandshake'});
    expect(result.sentinelMatches).toBe(true);
  });

  it('subsequent sync batches succeed after a prior batch (state cleanly resets)', async () => {
    h = setupHarness({
      identity<T>(v: T) {
        return v;
      },
    });
    await h.cmd({type: 'handshake'});

    const first = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{method: 'identity', params: ['first']}],
    });
    expect(
      (first.results[0] as Extract<WireMessage, {type: 'result'}>).value,
    ).toBe('first');

    const second = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{method: 'identity', params: ['second']}],
    });
    expect(
      (second.results[0] as Extract<WireMessage, {type: 'result'}>).value,
    ).toBe('second');
  });

  it('sends the @R root notification through the base transport (not via SAB)', async () => {
    // Sanity check that non-sync outbound traffic passes through to the
    // base transport unchanged. RPC.addClient sends `@R` synchronously
    // on connect; it should show up on `baseSent` (not get captured).
    h = setupHarness({foo: 'bar'});
    await h.cmd({type: 'handshake'});

    // `@R` is a notification, so it MUST pass through even while no
    // sync batch is active. (activeSyncSeq is 0 at this point.)
    const sawRoot = h.baseSent.some(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        (m as {type?: string}).type === 'notification' &&
        (m as {method?: string}).method === '@R',
    );
    expect(sawRoot).toBe(true);
  });

  it('notifications during the capture window pass through to the base (not captured)', async () => {
    // The RPC pushes signal updates etc. via outbound notifications.
    // Per design, notifications are NEVER captured by the sync window
    // in M001 — only `result` / `error` frames matching the batch's
    // synth ids are. The drain-barrier replay log (M002) will revisit
    // this; for now we assert pass-through.
    let triggerNotify: (() => void) | undefined;
    h = setupHarness({
      ping() {
        // Schedule a notification to fire during the dispatch window.
        // We can't hit the precise window from inside this method
        // without access to RPC internals, but issuing a notify here
        // is enough to verify the routing path doesn't accidentally
        // capture it.
        h?.rpc.notify('test-event', [{hello: 'world'}]);
        triggerNotify?.();
        return 'pong';
      },
    });
    await h.cmd({type: 'handshake'});

    const before = h.baseSent.filter(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        (m as {type?: string}).type === 'notification' &&
        (m as {method?: string}).method === 'test-event',
    ).length;

    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{method: 'ping'}],
    });
    expect(
      (results[0] as Extract<WireMessage, {type: 'result'}>).value,
    ).toBe('pong');

    const after = h.baseSent.filter(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        (m as {type?: string}).type === 'notification' &&
        (m as {method?: string}).method === 'test-event',
    ).length;
    // The notification should have been forwarded to the base
    // transport rather than captured by the sync window.
    expect(after - before).toBeGreaterThanOrEqual(1);
  });

  it('async result of an in-flight non-sync call is NOT captured by the sync window', async () => {
    // Build a root that lets us race an async dispatch against a sync
    // batch on the same client. The non-sync call's `result` frame has
    // an id outside the synth-id namespace, so the wrapper must
    // forward it to the base transport.
    h = setupHarness({
      slow(): Promise<string> {
        return new Promise((resolve) => setTimeout(() => resolve('slow'), 50));
      },
      quick() {
        return 'quick';
      },
    });
    await h.cmd({type: 'handshake'});

    // Fire an async call directly via the base transport with a real
    // client-style id (e.g. 1). This bypasses the worker fixture's
    // sync path; the RPC will respond via the wrapper's `send` which
    // should forward to the base.
    h.base; // (referenced; not used directly below)

    // Push an async call frame as if the worker had sent one normally.
    // We hand-craft the WireMessage to keep the fixture simple.
    const asyncCall: WireMessage = {
      type: 'call',
      id: 1,
      method: 'slow',
      params: [],
    };
    await h.cmd({type: 'send-async', msg: asyncCall});

    // Interleave a sync batch.
    const {results} = await h.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{method: 'quick'}],
    });
    expect(
      (results[0] as Extract<WireMessage, {type: 'result'}>).value,
    ).toBe('quick');

    // Give the slow async call time to settle and emit its result via
    // the base transport.
    await new Promise((r) => setTimeout(r, 100));

    // The slow call's `result` frame (id=1) must appear on the base —
    // it's an async response, not part of the sync batch.
    const sawAsyncResult = h.baseSent.some(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        (m as {type?: string}).type === 'result' &&
        (m as {id?: number}).id === 1,
    );
    expect(sawAsyncResult).toBe(true);

    // And it must NOT appear in the sync batch's results.
    expect(
      results.find(
        (m) => (m as {id?: number}).id === 1,
      ),
    ).toBeUndefined();
  });
});
