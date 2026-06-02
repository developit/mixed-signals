import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../shared/protocol.ts';
import {SyncRPCIframeBridgeError, SyncRPCTimeoutError} from './errors.ts';
import {CHUNK_STATE, CTRL, storeCtrl} from './lane.ts';

/**
 * Out-of-band sync-transport control frames carried over the base
 * postMessage transport. Mirror of the server-side `SyncControl`.
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

function isHandshakeRes(
  data: unknown,
): data is Extract<SyncControl, {__sync: 'hs-res'}> {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as {__sync?: unknown}).__sync === 'hs-res'
  );
}

/**
 * Caller-side: initiate the SAB handshake over `transport` and
 * resolve with a sync-capable `Transport` whose `wait?` method runs
 * the request/response chunk-state machine.
 *
 * Pass the result to `new RPCClient(...)`. The returned transport
 * proxies `send`, `onMessage`, `encode`, `decode`, and `ready` from
 * the base transport unchanged; only the `wait?` method is new.
 *
 * **Handshake protocol.** On invocation, posts `{__sync: 'hs-req'}`
 * to the base transport and awaits a matching `{__sync: 'hs-res',
 * control, data}` reply with both SABs. Rejects with
 * `SyncRPCTimeoutError` if no reply arrives within `opts.timeoutMs`
 * (default 5000 ms). Rejects with `SyncRPCIframeBridgeError` if the
 * `hs-res` payload's SAB fields aren't `SharedArrayBuffer` instances
 * — that condition indicates a topology misconfiguration (e.g., a
 * cross-origin iframe boundary the SAB transfer cannot cross; see
 * design §6.3).
 *
 * **Handshake message queue.** The host's `@R` root notification
 * commonly arrives *before* the `RPCClient` constructor (which
 * follows this function's resolution) gets a chance to subscribe via
 * `wrapper.onMessage(cb)`. Any non-handshake messages received in
 * the handshake window are buffered in arrival order and replayed
 * to the first `cb` the wrapper sees, preserving order across the
 * subscription boundary. After replay, the wrapper forwards inbound
 * traffic live.
 *
 * **`wait` semantics.** The returned transport's `wait?` method is
 * synchronous — it runs `Atomics.wait` to block the calling worker.
 * Browsers and Node both forbid `Atomics.wait` on the main thread,
 * so this method must only be called from a worker context. The
 * method accepts pre-encoded `WireMessage[]` and returns response
 * `WireMessage[]` in input order; brand substitution and hydration
 * are the consumer's responsibility (handled by `RPCClient.wait`).
 *
 * @throws SyncRPCTimeoutError — handshake didn't complete within
 *   `timeoutMs`, OR a subsequent `wait` call's `Atomics.wait` timed
 *   out (only when the `wait` caller supplied `timeoutMs`; there is
 *   no finite default per design §14).
 * @throws SyncRPCIframeBridgeError — handshake response carried
 *   malformed SAB fields.
 * @throws RangeError — `opts.timeoutMs` is not a positive finite
 *   number.
 */
export function enableSyncClient(
  transport: RawTransport,
  opts?: {timeoutMs?: number},
): Promise<RawTransport> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isInteger(timeoutMs)
  ) {
    return Promise.reject(
      new RangeError(
        `enableSyncClient: opts.timeoutMs must be a positive integer; got ${timeoutMs}`,
      ),
    );
  }

  // Per-instance state. Resolved once the handshake completes.
  let control!: SharedArrayBuffer;
  let data!: SharedArrayBuffer;
  let controlView!: Int32Array;
  let dataU8!: Uint8Array;

  // Subscription routing. Until the consumer calls
  // `wrapper.onMessage(cb)`, inbound non-handshake messages are
  // buffered to preserve arrival order across the subscription
  // boundary — the host's `@R` root notification typically lands
  // before the `RPCClient` constructor subscribes.
  let rpcSubscriber:
    | ((data: unknown, ctx?: TransportContext) => void | Promise<void>)
    | undefined;
  const pending: Array<{data: unknown; ctx: TransportContext | undefined}> =
    [];

  let handshakeResolved = false;
  let handshakeResolve: (() => void) | undefined;
  let handshakeReject: ((err: unknown) => void) | undefined;

  transport.onMessage((msg, ctx) => {
    if (!handshakeResolved && isHandshakeRes(msg)) {
      if (
        !(msg.control instanceof SharedArrayBuffer) ||
        !(msg.data instanceof SharedArrayBuffer)
      ) {
        handshakeReject?.(
          new SyncRPCIframeBridgeError(
            'sync handshake response carried malformed SAB fields; ' +
              'verify the host wrapper and that the parent ↔ iframe ' +
              'boundary is same-origin (see design §6.3)',
          ),
        );
        return;
      }
      control = msg.control;
      data = msg.data;
      controlView = new Int32Array(control);
      dataU8 = new Uint8Array(data);
      handshakeResolved = true;
      handshakeResolve?.();
      return;
    }
    // Non-handshake inbound: route live to the RPCClient if it has
    // subscribed yet, otherwise buffer.
    if (rpcSubscriber) {
      rpcSubscriber(msg, ctx);
    } else {
      pending.push({data: msg, ctx});
    }
  });

  const handshakeReq: SyncControl = {__sync: 'hs-req'};
  transport.send(handshakeReq);

  const handshake = new Promise<void>((resolve, reject) => {
    handshakeResolve = resolve;
    handshakeReject = reject;
    const timer = setTimeout(() => {
      reject(
        new SyncRPCTimeoutError(
          `sync handshake timed out after ${timeoutMs} ms`,
        ),
      );
    }, timeoutMs);
    // Don't keep the Node event loop alive solely for this timer;
    // browsers ignore `.unref` so this is a no-op there.
    (timer as unknown as {unref?: () => void}).unref?.();
  });

  let nextSeq = 1;

  function wait(
    calls: WireMessage[],
    waitOpts?: {timeoutMs?: number},
  ): WireMessage[] {
    if (waitOpts?.timeoutMs != null) {
      const t = waitOpts.timeoutMs;
      if (!Number.isFinite(t) || t <= 0 || !Number.isInteger(t)) {
        throw new RangeError(
          `rpc.wait: opts.timeoutMs must be a positive integer; got ${t}`,
        );
      }
    }

    const seq = nextSeq++;
    const envelope = {seq, calls};
    const requestJson = JSON.stringify(envelope);
    const encoded = new TextEncoder().encode(requestJson);
    const totalBytes = encoded.byteLength;
    const chunkBytes = dataU8.byteLength;

    // Single deadline shared across the request and response loops.
    // Computed once here so both legs of the round trip honour the
    // same wall-clock budget; previously the request loop ignored
    // the deadline entirely, so a host that stalled between MORE_REQ
    // chunks blocked the worker forever despite `timeoutMs`.
    const deadline =
      waitOpts?.timeoutMs == null ? null : Date.now() + waitOpts.timeoutMs;
    let chunkIndex = 0;

    // ── Request side ─────────────────────────────────────────────────────
    // `JSON.stringify({seq, calls})` always produces at least
    // `{"seq":N,"calls":[]}` — non-zero — so one iteration through
    // the do/while always fires, covering the empty-batch case.
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
        // First chunk: publish BATCH_SIZE + REQUEST_SEQ for the host
        // to read once. The host doesn't `Atomics.wait` on
        // REQUEST_SEQ (it can't from a main thread), but the notify
        // is kept for symmetry and future use (drain barrier in
        // M002+ may consume the SEQ slot).
        storeCtrl(controlView, CTRL.BATCH_SIZE, calls.length);
        storeCtrl(controlView, CTRL.REQUEST_SEQ, seq);
        Atomics.notify(controlView, CTRL.REQUEST_SEQ);
      }

      const doorbell: SyncControl = {__sync: 'doorbell', seq};
      transport.send(doorbell);

      offset += thisChunkSize;
      chunkIndex++;

      if (!isLast) {
        // Wait for the host to ack this chunk before writing the next.
        // Loop on exact target state to defend against spurious wakes
        // (`Atomics.wait` returning `'ok'` or `'not-equal'` without
        // CHUNK_STATE actually advancing). Deadline-bounded so a host
        // that stalls mid-request can't wedge the worker forever.
        while (true) {
          const cur = Atomics.load(controlView, CTRL.CHUNK_STATE);
          if (cur === CHUNK_STATE.ACK_REQ) break;
          const remainingMs =
            deadline == null
              ? Number.POSITIVE_INFINITY
              : deadline - Date.now();
          if (deadline != null && remainingMs <= 0) {
            throw new SyncRPCTimeoutError(
              `rpc.wait(seq=${seq}) timed out awaiting ACK_REQ at chunk ${chunkIndex} after ${waitOpts!.timeoutMs} ms`,
            );
          }
          const status = Atomics.wait(
            controlView,
            CTRL.CHUNK_STATE,
            cur,
            remainingMs,
          );
          if (status === 'timed-out') {
            throw new SyncRPCTimeoutError(
              `rpc.wait(seq=${seq}) timed out at chunk ${chunkIndex} (Atomics.wait status=timed-out)`,
            );
          }
          // 'ok' or 'not-equal' — re-read CHUNK_STATE and loop.
        }
      }
    } while (offset < totalBytes);

    // ── Response side ────────────────────────────────────────────────────
    chunkIndex = 0;
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
        chunkIndex++;

        if (cs === CHUNK_STATE.DONE_RES) break;

        // Intermediate chunk: ack and pull next.
        storeCtrl(controlView, CTRL.CHUNK_STATE, CHUNK_STATE.ACK_RES);
        const pull: SyncControl = {__sync: 'pull', seq};
        transport.send(pull);
        continue;
      }

      // Deadline-bounded wait. `Date.now() - deadline` is monotonic
      // enough for the µs-to-ms granularity of a sync round-trip
      // timeout; jitter is dominated by the cross-origin postMessage
      // latency, not by clock skew.
      const remainingMs =
        deadline == null ? Number.POSITIVE_INFINITY : deadline - Date.now();
      if (deadline != null && remainingMs <= 0) {
        throw new SyncRPCTimeoutError(
          `rpc.wait(seq=${seq}) timed out after ${waitOpts!.timeoutMs} ms (chunk ${chunkIndex})`,
        );
      }
      const status = Atomics.wait(
        controlView,
        CTRL.CHUNK_STATE,
        cs,
        remainingMs,
      );
      if (status === 'timed-out') {
        throw new SyncRPCTimeoutError(
          `rpc.wait(seq=${seq}) timed out at chunk ${chunkIndex} (Atomics.wait status=timed-out)`,
        );
      }
      // 'ok' or 'not-equal' — re-read CHUNK_STATE and loop.
    }

    const responseJson = new TextDecoder().decode(responseAccumulator);
    const response = JSON.parse(responseJson) as {
      seq: number;
      results: WireMessage[];
    };
    return response.results;
  }

  const wrapper: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      transport.send(data, ctx);
    },
    onMessage(cb) {
      rpcSubscriber = cb;
      // Drain any messages that arrived during the handshake window
      // so the RPCClient sees them in order. Subsequent traffic
      // routes live in the inbound handler above.
      if (pending.length > 0) {
        const drained = pending.splice(0);
        for (const item of drained) cb(item.data, item.ctx);
      }
    },
    encode: transport.encode,
    decode: transport.decode,
    ready: transport.ready,
    wait,
  };

  return handshake.then(() => wrapper);
}
