/**
 * Two-SAB lane layout for sync RPC. Two `SharedArrayBuffer`s per client:
 *
 *   - **Control SAB** (256 bytes, fixed): cache-line-friendly `Int32`
 *     header. Houses the `Atomics.wait` / `Atomics.notify` synchronization
 *     primitives and the chunk-state machine that pumps payloads through
 *     the data SAB.
 *   - **Data SAB** (64 KiB default, 256 KiB max): the reusable payload
 *     buffer carrying request and response envelopes. Payloads larger
 *     than the SAB chunk through via the chunk-state machine.
 *
 * Slot indices in `CTRL` are Int32 indices (slots), not byte offsets — a
 * value of `2` means "the third 4-byte slot", i.e., byte offset 8.
 * Construct an `Int32Array` view on the control SAB and index it directly
 * with these values.
 */

// ── Control SAB layout ─────────────────────────────────────────────────────

export const CONTROL_SAB_BYTES = 256;
export const LANE_VERSION = 1;

/** Int32 slot indices inside the control SAB. */
export const CTRL = {
  /** Protocol version; bumps on wire-format changes. */
  LANE_VERSION: 0,
  /** Coarse lane state: idle / request-in-flight / servicing / poisoned. */
  LANE_STATE: 1,
  /** Caller writes; servicer waits on this to wake up. */
  REQUEST_SEQ: 2,
  /** Servicer writes; caller waits on this to wake up. */
  RESPONSE_SEQ: 3,
  /** Number of calls in this `wait` envelope (N-arity). */
  BATCH_SIZE: 4,
  /** Chunk-state machine; six values, see `CHUNK_STATE`. */
  CHUNK_STATE: 5,
  /** Bytes valid in data SAB for the current chunk. */
  CHUNK_BYTES_VALID: 6,
  /** Servicer sets while dispatching a sync batch; routes outbound frames. */
  ACTIVE_SYNC_SEQ: 7,
  /** Monotonic server→client frame id. */
  SERVER_OUT_SEQ: 8,
  /** Last `SERVER_OUT_SEQ` the client has applied. */
  CLIENT_APPLIED_SEQ: 9,
  /** Set on timeout — quarantines this lane. */
  CANCEL_SEQ: 10,
  /** 0=alive, 1=dead (set by lifecycle owner on teardown). */
  CALLER_STATE: 11,
} as const;

/** Coarse lane state machine. */
export const LANE_STATE = {
  IDLE: 0,
  REQ: 1,
  SERVICING: 2,
  POISONED: 3,
} as const;

/**
 * Chunk-state machine. Caller and host both read/write this single slot
 * to pump request and response envelopes through the data SAB.
 *
 *   - `DONE` — idle, or final chunk of the request side (caller's last write).
 *   - `MORE_REQ` — caller wrote a non-final request chunk; host should ack + wait.
 *   - `ACK_REQ` — host ack'd a request chunk; caller can write the next.
 *   - `MORE_RES` — host wrote a non-final response chunk; caller should ack + pull.
 *   - `ACK_RES` — caller ack'd a response chunk; host can write the next.
 *   - `DONE_RES` — host wrote the final response chunk; caller decodes the
 *     accumulator and resumes.
 *
 * `DONE_RES` is distinct from `DONE` so the caller's `Atomics.wait` on
 * `CHUNK_STATE` reliably wakes when the response is ready. After the
 * request loop, `CHUNK_STATE` is left at `DONE`; reusing `DONE` for
 * response completion would produce no transition and stall the caller
 * on a single-chunk response.
 */
export const CHUNK_STATE = {
  DONE: 0,
  MORE_REQ: 1,
  ACK_REQ: 2,
  MORE_RES: 3,
  ACK_RES: 4,
  DONE_RES: 5,
} as const;

/** Caller liveness, set by the lifecycle owner on worker teardown. */
export const CALLER_STATE = {
  ALIVE: 0,
  DEAD: 1,
} as const;

// ── Data SAB layout ────────────────────────────────────────────────────────

export const MIN_DATA_SAB_BYTES = 4 * 1024;
export const DEFAULT_DATA_SAB_BYTES = 64 * 1024;
export const MAX_DATA_SAB_BYTES = 256 * 1024;

/**
 * Per-call header inside the data SAB:
 *
 *   `[TYPE: Int32] [LEN: Int32] [INLINE_VAL: Float64] [bytes...]`
 *
 * `TYPE = JSON` carries a JSON-encoded `WireMessage[]` envelope. The
 * remaining values (`VOID` / `BOOL` / `F64` / `HANDLE_ID`) are reserved
 * for a fast-path encoding that bypasses `JSON.parse` for primitive
 * returns.
 */
export const WIRE_TYPE = {
  JSON: 0,
  VOID: 1,
  BOOL: 2,
  F64: 3,
  HANDLE_ID: 4,
} as const;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Allocate fresh control + data SABs. The caller is the lifecycle owner:
 * it transfers the SABs to the worker as part of the sync transport
 * handshake, and disposes them when the worker is torn down.
 *
 * Throws `RangeError` if `dataSabBytes` is not an integer, or is outside
 * `[MIN_DATA_SAB_BYTES, MAX_DATA_SAB_BYTES]`. The integer check is
 * essential: `NaN < MIN` and `NaN > MAX` are both `false`, and
 * `new SharedArrayBuffer(NaN)` coerces `NaN` to a zero-byte buffer
 * — a silent allocation failure that would corrupt the protocol.
 */
export function allocateLane(
  dataSabBytes: number = DEFAULT_DATA_SAB_BYTES,
): {control: SharedArrayBuffer; data: SharedArrayBuffer} {
  if (!Number.isInteger(dataSabBytes)) {
    throw new RangeError(
      `data SAB size ${dataSabBytes} must be an integer`,
    );
  }
  if (dataSabBytes < MIN_DATA_SAB_BYTES) {
    throw new RangeError(
      `data SAB size ${dataSabBytes} is below min ${MIN_DATA_SAB_BYTES}`,
    );
  }
  if (dataSabBytes > MAX_DATA_SAB_BYTES) {
    throw new RangeError(
      `data SAB size ${dataSabBytes} exceeds max ${MAX_DATA_SAB_BYTES}`,
    );
  }
  const control = new SharedArrayBuffer(CONTROL_SAB_BYTES);
  const data = new SharedArrayBuffer(dataSabBytes);

  // Initialize control header to a known-good idle state.
  const view = new Int32Array(control);
  Atomics.store(view, CTRL.LANE_VERSION, LANE_VERSION);
  Atomics.store(view, CTRL.LANE_STATE, LANE_STATE.IDLE);
  Atomics.store(view, CTRL.CALLER_STATE, CALLER_STATE.ALIVE);

  return {control, data};
}

/** Cheap accessor: read an Int32 slot atomically. */
export function loadCtrl(view: Int32Array, slot: number): number {
  return Atomics.load(view, slot);
}

/** Cheap accessor: write an Int32 slot atomically. */
export function storeCtrl(view: Int32Array, slot: number, value: number): void {
  Atomics.store(view, slot, value);
}
