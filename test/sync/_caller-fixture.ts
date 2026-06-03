/**
 * Caller-side worker fixture for `enableSyncServer` tests.
 *
 * Runs in a `node:worker_threads` Worker. Drives the SAB caller
 * protocol directly using raw `Atomics.wait` + a `RawTransport` over
 * `parentPort`, independent of `enableSyncClient` (M001I003T). This
 * lets `enable-server.test.ts` validate the host wrapper end-to-end
 * without depending on the caller-side wrapper.
 *
 * Multiplexes two channels over `parentPort` so the same MessagePort
 * carries both the sync-RPC transport traffic and the test-driver
 * command/result traffic:
 *
 *   `{kind: 'mixed-signals', data}` — RPC base transport (handshake,
 *     doorbell, pull, normal `WireMessage`s).
 *   `{kind: 'test', data}` — test-driver commands.
 *
 * The fixture does NOT use `RPCClient`; it manipulates `WireMessage`s
 * directly so it has no dependency on hydrator / brand machinery.
 */
import {parentPort} from 'node:worker_threads';
import {CHUNK_STATE, CTRL, storeCtrl} from '../../sync/lane.ts';
import type {WireMessage} from '../../shared/protocol.ts';

if (!parentPort) {
  throw new Error('_caller-fixture must run inside a Node Worker');
}

type SyncControl =
  | {__sync: 'hs-req'}
  | {
      __sync: 'hs-res';
      control: SharedArrayBuffer;
      data: SharedArrayBuffer;
    }
  | {__sync: 'doorbell'; seq: number}
  | {__sync: 'pull'; seq: number};

function isHandshakeRes(
  data: unknown,
): data is Extract<SyncControl, {__sync: 'hs-res'}> {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as {__sync?: unknown}).__sync === 'hs-res'
  );
}

type TestCommand =
  | {type: 'handshake'; id: number}
  | {
      type: 'wait-batch';
      id: number;
      calls: Array<{method: string; params?: unknown[]}>;
      timeoutMs?: number;
    }
  | {type: 'send-async'; id: number; msg: WireMessage}
  | {type: 'rehandshake'; id: number};

type TestResult =
  | {type: 'ready'}
  | {type: 'fatal'; error: string}
  | {
      type: 'handshake-result';
      id: number;
      ok: true;
      controlBytes: number;
      dataBytes: number;
    }
  | {
      type: 'wait-batch-result';
      id: number;
      ok: true;
      results: WireMessage[];
    }
  | {
      type: 'send-async-result';
      id: number;
      ok: true;
    }
  | {
      type: 'rehandshake-result';
      id: number;
      ok: true;
      controlBytes: number;
      dataBytes: number;
      /**
       * Sentinel byte we wrote into the prior control SAB before the
       * re-handshake. If the host reused the underlying SAB, reading
       * the same slot through the freshly-received wrapper returns
       * the same byte. (SAB wrappers are not `===` across
       * postMessage boundaries in Node even when memory is shared,
       * so we test by memory-sharing, not reference equality.)
       */
      sentinelMatches: boolean;
    }
  | {type: 'command-result'; id: number; ok: false; error: string};

const pendingHandshake: Array<
  (res: Extract<SyncControl, {__sync: 'hs-res'}>) => void
> = [];

let control: SharedArrayBuffer | null = null;
let data: SharedArrayBuffer | null = null;
let controlView: Int32Array | null = null;
let dataU8: Uint8Array | null = null;
let nextSeq = 1;

function sendBase(payload: unknown): void {
  parentPort!.postMessage({kind: 'mixed-signals', data: payload});
}

function sendTest(result: TestResult): void {
  parentPort!.postMessage({kind: 'test', data: result});
}

// Multiplexed inbound dispatch.
parentPort.on('message', (envelope: {kind: string; data: unknown}) => {
  if (envelope?.kind === 'mixed-signals') {
    const msg = envelope.data;
    if (isHandshakeRes(msg)) {
      const resolver = pendingHandshake.shift();
      resolver?.(msg);
      return;
    }
    // Other base-transport traffic (e.g. `@R` root notification from
    // the host RPC) is silently dropped — the fixture doesn't run an
    // RPCClient, so there's nothing to hydrate. The host doesn't gate
    // on the worker subscribing to anything.
    return;
  }
  if (envelope?.kind === 'test') {
    handleTestCommand(envelope.data as TestCommand);
  }
});

async function handleTestCommand(cmd: TestCommand): Promise<void> {
  try {
    switch (cmd.type) {
      case 'handshake': {
        const {control: c, data: d} = await runHandshake();
        sendTest({
          type: 'handshake-result',
          id: cmd.id,
          ok: true,
          controlBytes: c.byteLength,
          dataBytes: d.byteLength,
        });
        return;
      }
      case 'rehandshake': {
        // Stamp a sentinel byte into the LANE_VERSION slot of the
        // currently-held control SAB. After re-handshake, read the
        // same slot from the newly-received wrapper. If the host
        // reused the underlying SAB the byte is preserved; if the
        // host allocated fresh, it's overwritten by
        // `allocateLane` (which resets LANE_VERSION to 1).
        if (controlView === null) {
          throw new Error('rehandshake before initial handshake');
        }
        const sentinel = 0xfeed;
        storeCtrl(controlView, CTRL.LANE_VERSION, sentinel);
        const {control: c, data: d} = await runHandshake();
        const newView = new Int32Array(c);
        const observed = newView[CTRL.LANE_VERSION];
        sendTest({
          type: 'rehandshake-result',
          id: cmd.id,
          ok: true,
          controlBytes: c.byteLength,
          dataBytes: d.byteLength,
          sentinelMatches: observed === sentinel,
        });
        return;
      }
      case 'wait-batch': {
        const results = runWait(cmd.calls, cmd.timeoutMs);
        sendTest({
          type: 'wait-batch-result',
          id: cmd.id,
          ok: true,
          results,
        });
        return;
      }
      case 'send-async': {
        sendBase(cmd.msg);
        sendTest({type: 'send-async-result', id: cmd.id, ok: true});
        return;
      }
    }
  } catch (err) {
    sendTest({
      type: 'command-result',
      id: (cmd as {id: number}).id,
      ok: false,
      error: (err as Error).message,
    });
  }
}

function runHandshake(): Promise<Extract<SyncControl, {__sync: 'hs-res'}>> {
  return new Promise((resolve) => {
    pendingHandshake.push((res) => {
      control = res.control;
      data = res.data;
      controlView = new Int32Array(control);
      dataU8 = new Uint8Array(data);
      resolve(res);
    });
    sendBase({__sync: 'hs-req'} satisfies SyncControl);
  });
}

/**
 * Run the SAB caller protocol for one batch: chunk the request envelope
 * across the data SAB, doorbell per chunk, `Atomics.wait` for acks,
 * accumulate response chunks, decode, return.
 *
 * Mirrors what `enableSyncClient`'s `wait?` method (M001I003T) will do,
 * but inlined here so this fixture has no dependency on M001I003T.
 */
function runWait(
  calls: Array<{method: string; params?: unknown[]}>,
  timeoutMs: number | undefined,
): WireMessage[] {
  if (controlView === null || dataU8 === null) {
    throw new Error('runWait before handshake');
  }
  const seq = nextSeq++;
  const envelope = {seq, calls};
  const requestJson = JSON.stringify(envelope);
  const encoded = new TextEncoder().encode(requestJson);
  const totalBytes = encoded.byteLength;
  const chunkBytes = dataU8.byteLength;

  // Single deadline shared across the request and response loops.
  // Computed once here so both legs of the round trip honour the same
  // wall-clock budget; the request loop previously had no timeout so
  // a host stalled between MORE_REQ chunks wedged the worker forever.
  const deadline =
    timeoutMs == null ? null : Date.now() + timeoutMs;

  // ── Request side ──────────────────────────────────────────────────────
  // `JSON.stringify({seq, calls})` is never zero bytes (the wrapping
  // object always serializes to at least `{"seq":N,"calls":[]}`), so a
  // single non-empty chunk always covers the empty-batch case.
  let offset = 0;
  do {
    const remaining = totalBytes - offset;
    const thisChunkSize = Math.min(remaining, chunkBytes);
    const isLast = offset + thisChunkSize === totalBytes;

    dataU8.set(encoded.subarray(offset, offset + thisChunkSize), 0);
    storeCtrl(controlView, CTRL.CHUNK_BYTES_VALID, thisChunkSize);
    storeCtrl(
      controlView,
      CTRL.CHUNK_STATE,
      isLast ? CHUNK_STATE.DONE : CHUNK_STATE.MORE_REQ,
    );
    if (offset === 0) {
      storeCtrl(controlView, CTRL.BATCH_SIZE, calls.length);
      storeCtrl(controlView, CTRL.REQUEST_SEQ, seq);
      Atomics.notify(controlView, CTRL.REQUEST_SEQ);
    }

    sendBase({__sync: 'doorbell', seq} satisfies SyncControl);

    offset += thisChunkSize;

    if (!isLast) {
      // Wait for the host to ack this chunk before writing the next.
      // Deadline-bounded so this reference fixture stays a faithful
      // analog of the production wrapper — the request-side timeout
      // is part of the protocol contract, not just the response side.
      while (true) {
        const cur = Atomics.load(controlView, CTRL.CHUNK_STATE);
        if (cur === CHUNK_STATE.ACK_REQ) break;
        const remainingMs =
          deadline == null ? Number.POSITIVE_INFINITY : deadline - Date.now();
        if (deadline != null && remainingMs <= 0) {
          throw new Error(
            `runWait(seq=${seq}) timed out awaiting ACK_REQ after ${timeoutMs} ms`,
          );
        }
        const status = Atomics.wait(
          controlView,
          CTRL.CHUNK_STATE,
          cur,
          remainingMs,
        );
        if (status === 'timed-out') {
          throw new Error(
            `runWait(seq=${seq}) timed out (Atomics.wait status=timed-out, request side)`,
          );
        }
      }
    }
  } while (offset < totalBytes);

  // ── Response side ─────────────────────────────────────────────────────
  // (`deadline` was lifted above the request loop so a stalling host
  // on the request side can't wedge the worker forever.)
  let responseAccumulator = new Uint8Array(0);
  while (true) {
    const cs = Atomics.load(controlView, CTRL.CHUNK_STATE);

    if (cs === CHUNK_STATE.MORE_RES || cs === CHUNK_STATE.DONE_RES) {
      const bytesValid = Atomics.load(controlView, CTRL.CHUNK_BYTES_VALID);
      const chunk = dataU8.slice(0, bytesValid);
      const next = new Uint8Array(
        responseAccumulator.byteLength + chunk.byteLength,
      );
      next.set(responseAccumulator, 0);
      next.set(chunk, responseAccumulator.byteLength);
      responseAccumulator = next;

      if (cs === CHUNK_STATE.DONE_RES) break;

      // Intermediate chunk: ack and pull next.
      storeCtrl(controlView, CTRL.CHUNK_STATE, CHUNK_STATE.ACK_RES);
      sendBase({__sync: 'pull', seq} satisfies SyncControl);
      continue;
    }

    const remaining =
      deadline == null ? Number.POSITIVE_INFINITY : deadline - Date.now();
    if (deadline != null && remaining <= 0) {
      throw new Error(
        `runWait(seq=${seq}) timed out after ${timeoutMs} ms`,
      );
    }
    const status = Atomics.wait(
      controlView,
      CTRL.CHUNK_STATE,
      cs,
      remaining,
    );
    if (status === 'timed-out') {
      throw new Error(
        `runWait(seq=${seq}) timed out (Atomics.wait status=timed-out)`,
      );
    }
    // 'ok' or 'not-equal' — re-read CHUNK_STATE.
  }

  const responseJson = new TextDecoder().decode(responseAccumulator);
  const response = JSON.parse(responseJson) as {
    seq: number;
    results: WireMessage[];
  };
  return response.results;
}

// Signal readiness so the test driver can start dispatching commands.
sendTest({type: 'ready'});
