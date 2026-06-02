import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../shared/protocol.ts';
import {
  allocateLane,
  CALLER_STATE,
  CHUNK_STATE,
  CTRL,
  DEFAULT_DATA_SAB_BYTES,
  loadCtrl,
  storeCtrl,
} from './lane.ts';

/**
 * Out-of-band sync-transport control frames carried over the base
 * postMessage transport. Distinguished from regular `WireMessage`s by
 * the reserved `__sync` field on the envelope.
 *
 * @internal
 */
type SyncControl =
  | {__sync: 'hs-req'}
  | {
      __sync: 'hs-res';
      control: SharedArrayBuffer;
      data: SharedArrayBuffer;
    }
  | {__sync: 'doorbell'; seq: number}
  | {__sync: 'pull'; seq: number};

function isSyncControl(data: unknown): data is SyncControl {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as {__sync?: unknown}).__sync === 'string'
  );
}

/**
 * Server-side: wraps a base `RawTransport` with a sync-capable
 * `Transport`. Pass the result to `rpc.addClient(...)`.
 *
 * The wrapper is inactive until the caller initiates the SAB handshake
 * via `enableSyncClient(...)` from a worker. Until that handshake fires,
 * every inbound and outbound frame passes through to the base transport
 * unchanged — the wrapper is indistinguishable from the base for
 * async-only callers.
 *
 * Once the handshake completes, the wrapper services sync calls by:
 *
 *   - Reading each request envelope from the data SAB via the six-state
 *     chunk machine (one chunk per inbound `{__sync: 'doorbell', seq}`).
 *   - Synthesizing one inbound `call` `WireMessage` per batch entry into
 *     the host RPC by invoking the callback `rpc.addClient(...)` wired
 *     into the wrapper's `onMessage`. The host RPC dispatches normally —
 *     it has no awareness of the sync mode.
 *   - Capturing matching outbound `result` / `error` frames (matched by
 *     synthesized id) while the active sync batch is in flight, instead
 *     of forwarding them to the base transport. All other outbound
 *     frames (notifications + responses for non-sync calls) pass through
 *     unchanged.
 *   - Once every expected response has been captured, encoding the
 *     response timeline and writing it back to the data SAB via the
 *     chunk machine (one chunk per inbound `{__sync: 'pull', seq}`,
 *     except the first chunk which goes out eagerly after dispatch).
 *
 * Synthesized inbound `call` ids start at 1,000,000 and increment
 * monotonically across batches, so they do not collide with the host
 * RPC's own client-side id space.
 *
 * **Handshake re-request.** If `hs-req` arrives more than once on the
 * same wrapper instance (e.g., a caller-side reconnect with a fresh
 * `RPCClient`), the wrapper reuses the existing SAB pair if one has
 * already been allocated, allocating fresh only on the first `hs-req`.
 * This is necessary because the worker holds references to the SABs it
 * received on the first `hs-res`; replacing them server-side would
 * leave the worker talking to dead memory. Worker teardown + fresh
 * SABs are owned by the lifecycle-owner protocol (M003+).
 *
 * **Non-sync pass-through.** Frames that do not carry a `__sync` field
 * are forwarded to / from the base transport unchanged, in both
 * directions. The existing async RPC dispatch path is unaffected.
 *
 * @throws RangeError when `opts.dataSabSize` is not an integer in the
 *   `[MIN_DATA_SAB_BYTES, MAX_DATA_SAB_BYTES]` range (validated by
 *   `allocateLane` on first `hs-req`).
 */
export function enableSyncServer(
  transport: RawTransport,
  opts?: {dataSabSize?: number},
): RawTransport {
  const dataSabSize = opts?.dataSabSize ?? DEFAULT_DATA_SAB_BYTES;

  // SAB pair + views. Allocated lazily on first `hs-req`; reused on
  // subsequent re-handshakes (see jsdoc above).
  let control: SharedArrayBuffer | null = null;
  let data: SharedArrayBuffer | null = null;
  let controlView: Int32Array | null = null;
  let dataU8: Uint8Array | null = null;

  // Capture window. While `activeSyncSeq !== 0`, outbound
  // `result` / `error` frames whose id is in `captureById`'s key set
  // are routed into the timeline instead of forwarded to the base.
  let activeSyncSeq = 0;
  let captureById: Map<number, WireMessage> | null = null;
  let captureExpected = 0;
  let captureFilled = 0;
  let onAllCaptured: (() => void) | null = null;

  // Multi-chunk request reassembly buffer. Single in-flight batch only
  // (sync is leaf-only, design §7), so one accumulator is enough.
  let requestAccumulator: Uint8Array | null = null;

  // Pending response chunks awaiting `pull` doorbells. The first chunk
  // ships eagerly after dispatch; subsequent chunks land in response to
  // caller-driven pulls.
  let responseQueue: {bytes: Uint8Array; offset: number} | null = null;

  // The single callback `rpc.addClient` registers via the wrapper's
  // `onMessage`. Non-sync inbound traffic and synthesized inbound calls
  // both flow through this.
  let rpcOnMessage:
    | ((data: unknown, ctx?: TransportContext) => void | Promise<void>)
    | undefined;

  // Monotonic synth id for inbound sync calls. Starts well above any
  // realistic client `nextId` flow so collision with the host RPC's
  // own id space is impossible.
  let nextSynthId = 1_000_000;

  // ── Inbound dispatch ───────────────────────────────────────────────────

  transport.onMessage(async (msg, ctx) => {
    if (isSyncControl(msg)) {
      if (msg.__sync === 'hs-req') {
        handleHandshake();
        return;
      }
      if (msg.__sync === 'doorbell') {
        await handleDoorbell(msg.seq);
        return;
      }
      if (msg.__sync === 'pull') {
        writeNextResponseChunk();
        return;
      }
      return; // unknown sync-control type — ignore
    }
    // Normal `WireMessage` from the caller (async path). Forward to RPC
    // if the host has wired up its callback; silently drop otherwise.
    // The drop case is unreachable in normal usage: `rpc.addClient` is
    // called synchronously after `enableSyncServer` returns, and the
    // base transport's inbound traffic cannot precede those calls in
    // the same tick.
    rpcOnMessage?.(msg, ctx);
  });

  // ── Handshake ──────────────────────────────────────────────────────────

  function handleHandshake(): void {
    // Reuse the existing SAB pair on re-handshake — the worker may
    // still be holding references to the originals. Allocate fresh
    // only on the first request.
    if (control === null || data === null) {
      const lane = allocateLane(dataSabSize);
      control = lane.control;
      data = lane.data;
      controlView = new Int32Array(control);
      dataU8 = new Uint8Array(data);
    }
    // Clear any half-built request from a prior connection. A
    // re-handshake mid-request is a protocol violation by the caller,
    // but resetting defensively keeps the wrapper in a clean state.
    requestAccumulator = null;
    transport.send({
      __sync: 'hs-res',
      control,
      data,
    } satisfies SyncControl);
  }

  // ── Doorbell (per-chunk request) ───────────────────────────────────────

  /**
   * One doorbell per request chunk. Reads the current chunk from the
   * data SAB, appends to the accumulator, then either:
   *
   *   - acks (`CHUNK_STATE = ACK_REQ` + `Atomics.notify`) so the caller
   *     can write the next chunk, or
   *   - finalizes (the caller wrote `CHUNK_STATE = DONE`): parses the
   *     assembled envelope and dispatches via `serviceSyncRequest`.
   *
   * The host cannot `Atomics.wait` on the main thread, so the caller
   * drives flow control by sending one doorbell per chunk. This handler
   * runs exactly once per doorbell.
   */
  async function handleDoorbell(seq: number): Promise<void> {
    if (controlView === null || dataU8 === null) {
      // Doorbell before handshake — protocol violation by caller.
      // Silently ignore; the caller's wait will time out.
      return;
    }
    if (loadCtrl(controlView, CTRL.CALLER_STATE) === CALLER_STATE.DEAD) {
      // Lifecycle owner has signalled the caller is gone (M003+).
      // Drop the request silently; do not write a response that nobody
      // will read.
      return;
    }

    const bytesValid = loadCtrl(controlView, CTRL.CHUNK_BYTES_VALID);
    const chunkState = loadCtrl(controlView, CTRL.CHUNK_STATE);

    // Copy out of the SAB-backed view before any decode pass.
    // `TextDecoder.decode()` rejects shared views in browsers.
    // `Uint8Array.prototype.slice` allocates a fresh non-shared buffer.
    const chunk = dataU8.slice(0, bytesValid);

    const accumulator =
      requestAccumulator ?? new Uint8Array(0);
    const combined = new Uint8Array(
      accumulator.byteLength + chunk.byteLength,
    );
    combined.set(accumulator, 0);
    combined.set(chunk, accumulator.byteLength);
    requestAccumulator = combined;

    if (chunkState === CHUNK_STATE.MORE_REQ) {
      // Ack so the caller can write the next chunk.
      storeCtrl(controlView, CTRL.CHUNK_STATE, CHUNK_STATE.ACK_REQ);
      Atomics.notify(controlView, CTRL.CHUNK_STATE);
      return;
    }

    // `CHUNK_STATE.DONE` — this was the final request chunk. Take
    // ownership of the accumulator and clear it so the wrapper is
    // ready for the next batch.
    const fullPayload = requestAccumulator;
    requestAccumulator = null;
    await serviceSyncRequest(seq, fullPayload);
  }

  // ── Dispatch ───────────────────────────────────────────────────────────

  async function serviceSyncRequest(
    seq: number,
    fullPayload: Uint8Array,
  ): Promise<void> {
    if (controlView === null || dataU8 === null) return;

    const requestJson = new TextDecoder().decode(fullPayload);
    const envelope = JSON.parse(requestJson) as {
      seq: number;
      calls: Array<{method: string; params?: unknown[]}>;
    };
    const calls = envelope.calls;

    // Set up the capture window before pushing any synth calls into
    // the RPC, so the very first outbound response is intercepted.
    activeSyncSeq = seq;
    captureById = new Map();
    captureExpected = calls.length;
    captureFilled = 0;
    const allDone = new Promise<void>((resolve) => {
      onAllCaptured = resolve;
    });

    // Map input order → synth id so we can reassemble the response
    // timeline in the caller's intended order, even if responses
    // arrive out of order (async dispatch in `RPC.handleMessage`).
    const orderedIds: number[] = [];
    for (const call of calls) {
      const synthId = nextSynthId++;
      orderedIds.push(synthId);
      // Pre-register the synth id so `wrapper.send`'s membership check
      // can distinguish sync-batch responses (capture) from
      // unrelated async-call responses (forward). The placeholder is
      // overwritten with the real frame when it arrives.
      captureById.set(synthId, undefined as unknown as WireMessage);
      // Re-stamp the call as a fresh inbound `WireMessage`. We
      // discard any id the caller-side envelope may carry — the host
      // owns id assignment for synth calls so they cannot collide
      // with the host RPC's own id space.
      const synthesized: WireMessage = {
        type: 'call',
        id: synthId,
        method: call.method,
        params: call.params ?? [],
      };
      rpcOnMessage?.(synthesized);
    }

    // Empty batch: nothing to wait for. Resolve immediately so the
    // response envelope contains an empty results array.
    if (captureExpected === 0) {
      onAllCaptured?.();
    }

    await allDone;

    // Assemble the response timeline in caller-input order. Any synth
    // id missing from `captureById` is a protocol bug (RPC dispatched
    // but never produced a `result`/`error`); fill with a defensive
    // error frame rather than crash the wrapper.
    const results: WireMessage[] = orderedIds.map((id) => {
      const captured = captureById?.get(id);
      if (captured) return captured;
      return {
        type: 'error',
        id,
        value: {message: `no response captured for synth id ${id}`},
      };
    });

    const responseJson = JSON.stringify({seq, results});
    const encoded = new TextEncoder().encode(responseJson);

    // Clear the capture window BEFORE writing response chunks so any
    // post-publish outbound frames (signal updates emitted between
    // sync calls, etc.) route normally via the async path.
    activeSyncSeq = 0;
    captureById = null;
    captureExpected = 0;
    captureFilled = 0;
    onAllCaptured = null;

    // Publish RESPONSE_SEQ — informational. The caller's wake signal
    // is `CHUNK_STATE = DONE_RES` on the final chunk; bumping
    // RESPONSE_SEQ here is for debuggability and M002+ (drain barrier
    // expects this slot to track per-batch completion).
    storeCtrl(controlView, CTRL.RESPONSE_SEQ, seq);

    responseQueue = {bytes: encoded, offset: 0};
    writeNextResponseChunk();
  }

  // ── Pull (per-chunk response) ──────────────────────────────────────────

  /**
   * Writes the next pending response chunk into the data SAB and
   * notifies the caller via `Atomics.notify` on `CHUNK_STATE`. Called
   * once eagerly after dispatch (first chunk), then again on each
   * `{__sync: 'pull', seq}` doorbell from the caller.
   *
   * `CHUNK_STATE = MORE_RES` for non-final chunks; `DONE_RES` for the
   * final chunk. `DONE_RES` is distinct from `DONE` (the idle / final
   * *request* state) so the caller's `Atomics.wait` on `CHUNK_STATE`
   * sees a transition even for single-chunk responses — without that
   * distinct state, a `DONE → DONE` non-transition would stall the
   * wake.
   */
  function writeNextResponseChunk(): void {
    if (controlView === null || dataU8 === null || responseQueue === null) {
      return;
    }
    const {bytes, offset} = responseQueue;
    const remaining = bytes.byteLength - offset;
    const thisChunkSize = Math.min(remaining, dataU8.byteLength);
    const isLast = offset + thisChunkSize === bytes.byteLength;

    dataU8.set(bytes.subarray(offset, offset + thisChunkSize), 0);
    storeCtrl(controlView, CTRL.CHUNK_BYTES_VALID, thisChunkSize);
    storeCtrl(
      controlView,
      CTRL.CHUNK_STATE,
      isLast ? CHUNK_STATE.DONE_RES : CHUNK_STATE.MORE_RES,
    );
    Atomics.notify(controlView, CTRL.CHUNK_STATE);

    if (isLast) {
      responseQueue = null;
    } else {
      responseQueue = {bytes, offset: offset + thisChunkSize};
    }
  }

  // ── Wrapped transport ──────────────────────────────────────────────────

  const wrapper: RawTransport = {
    mode: 'raw',
    send(payload, ctx) {
      // Intercept outbound `result` / `error` frames whose id matches
      // an in-flight sync batch. Everything else (including
      // `notification` frames + responses for async calls in flight)
      // passes through to the base transport unchanged.
      if (activeSyncSeq !== 0 && captureById !== null) {
        const msg = payload as WireMessage;
        if (
          msg &&
          (msg.type === 'result' || msg.type === 'error') &&
          captureById.has(msg.id)
        ) {
          // First write for this synth id replaces the placeholder.
          // Defensive: only bump `captureFilled` on the first write,
          // so an out-of-band re-emission (theoretically impossible
          // but cheap to guard against) doesn't over-count.
          const prior = captureById.get(msg.id);
          captureById.set(msg.id, msg);
          if (prior === undefined) {
            captureFilled++;
            if (captureFilled === captureExpected) onAllCaptured?.();
          }
          return;
        }
      }
      transport.send(payload, ctx);
    },
    onMessage(cb) {
      rpcOnMessage = cb;
    },
    encode: transport.encode,
    decode: transport.decode,
    ready: transport.ready,
  };

  return wrapper;
}
