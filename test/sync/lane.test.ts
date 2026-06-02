import {describe, expect, it} from 'vitest';
import {
  allocateLane,
  CALLER_STATE,
  CHUNK_STATE,
  CONTROL_SAB_BYTES,
  CTRL,
  DEFAULT_DATA_SAB_BYTES,
  LANE_STATE,
  LANE_VERSION,
  loadCtrl,
  MAX_DATA_SAB_BYTES,
  MIN_DATA_SAB_BYTES,
  storeCtrl,
  WIRE_TYPE,
} from '../../sync/lane.ts';
import {supportsSync} from '../../sync/support.ts';

describe('allocateLane', () => {
  it('returns two SABs at default sizes', () => {
    const {control, data} = allocateLane();
    expect(control).toBeInstanceOf(SharedArrayBuffer);
    expect(data).toBeInstanceOf(SharedArrayBuffer);
    expect(control.byteLength).toBe(CONTROL_SAB_BYTES);
    expect(data.byteLength).toBe(DEFAULT_DATA_SAB_BYTES);
  });

  it('honors a custom data SAB size', () => {
    const {data} = allocateLane(4 * 1024);
    expect(data.byteLength).toBe(4 * 1024);
  });

  it('honors the documented max data SAB size', () => {
    const {data} = allocateLane(MAX_DATA_SAB_BYTES);
    expect(data.byteLength).toBe(MAX_DATA_SAB_BYTES);
  });

  it('honors the documented min data SAB size', () => {
    const {data} = allocateLane(MIN_DATA_SAB_BYTES);
    expect(data.byteLength).toBe(MIN_DATA_SAB_BYTES);
  });

  it('throws RangeError when data SAB size exceeds MAX_DATA_SAB_BYTES', () => {
    expect(() => allocateLane(MAX_DATA_SAB_BYTES + 1)).toThrow(RangeError);
  });

  it('throws RangeError when data SAB size is below MIN_DATA_SAB_BYTES', () => {
    expect(() => allocateLane(MIN_DATA_SAB_BYTES - 1)).toThrow(RangeError);
  });

  it('throws RangeError when data SAB size is NaN', () => {
    // Both bounds comparisons return false for NaN, and
    // `new SharedArrayBuffer(NaN)` coerces to zero — the integer guard
    // catches the bug before either pathology fires.
    expect(() => allocateLane(Number.NaN)).toThrow(RangeError);
  });

  it('throws RangeError when data SAB size is non-integer', () => {
    expect(() => allocateLane(MIN_DATA_SAB_BYTES + 0.5)).toThrow(RangeError);
  });

  it('throws RangeError when data SAB size is Infinity', () => {
    expect(() => allocateLane(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('initializes the control header to an idle state', () => {
    const {control} = allocateLane();
    const view = new Int32Array(control);
    expect(loadCtrl(view, CTRL.LANE_VERSION)).toBe(LANE_VERSION);
    expect(loadCtrl(view, CTRL.LANE_STATE)).toBe(LANE_STATE.IDLE);
    expect(loadCtrl(view, CTRL.CALLER_STATE)).toBe(CALLER_STATE.ALIVE);
  });

  it('initializes every other CTRL slot to zero', () => {
    const {control} = allocateLane();
    const view = new Int32Array(control);
    const initialized = new Set<number>([
      CTRL.LANE_VERSION,
      CTRL.LANE_STATE,
      CTRL.CALLER_STATE,
    ]);
    for (const slot of Object.values(CTRL)) {
      if (initialized.has(slot)) continue;
      expect(loadCtrl(view, slot)).toBe(0);
    }
  });
});

describe('loadCtrl / storeCtrl', () => {
  it('round-trips through every CTRL slot', () => {
    const {control} = allocateLane();
    const view = new Int32Array(control);
    const slots = Object.values(CTRL);
    for (let i = 0; i < slots.length; i++) {
      const value = (i + 1) * 7; // arbitrary distinct non-zero
      storeCtrl(view, slots[i], value);
      expect(loadCtrl(view, slots[i])).toBe(value);
    }
  });

  it('writes and reads atomically across views over the same SAB', () => {
    const {control} = allocateLane();
    const writer = new Int32Array(control);
    const reader = new Int32Array(control);
    storeCtrl(writer, CTRL.REQUEST_SEQ, 42);
    expect(loadCtrl(reader, CTRL.REQUEST_SEQ)).toBe(42);
  });
});

describe('CHUNK_STATE', () => {
  it('has six distinct values', () => {
    const values = Object.values(CHUNK_STATE);
    expect(new Set(values).size).toBe(6);
  });

  it('matches the documented six-state machine', () => {
    expect(CHUNK_STATE.DONE).toBe(0);
    expect(CHUNK_STATE.MORE_REQ).toBe(1);
    expect(CHUNK_STATE.ACK_REQ).toBe(2);
    expect(CHUNK_STATE.MORE_RES).toBe(3);
    expect(CHUNK_STATE.ACK_RES).toBe(4);
    expect(CHUNK_STATE.DONE_RES).toBe(5);
  });

  it('keeps DONE_RES distinct from DONE so single-chunk responses transition', () => {
    // Regression guard: the whole point of DONE_RES is that the caller's
    // `Atomics.wait` on `CHUNK_STATE` sees a transition for a single-chunk
    // response. If DONE_RES collapses to DONE we lose that wake signal.
    expect(CHUNK_STATE.DONE_RES).not.toBe(CHUNK_STATE.DONE);
  });
});

describe('WIRE_TYPE', () => {
  it('matches the documented header type enum', () => {
    expect(WIRE_TYPE.JSON).toBe(0);
    expect(WIRE_TYPE.VOID).toBe(1);
    expect(WIRE_TYPE.BOOL).toBe(2);
    expect(WIRE_TYPE.F64).toBe(3);
    expect(WIRE_TYPE.HANDLE_ID).toBe(4);
  });

  it('has five distinct values', () => {
    expect(new Set(Object.values(WIRE_TYPE)).size).toBe(5);
  });
});

describe('supportsSync', () => {
  // Vitest runs these tests in Node's main process. The function should
  // report `false` regardless of which detection branch it ends up on —
  // either the `worker_threads.isMainThread === true` branch (when a
  // CommonJS `require` global is reachable) or the `globalThis.require
  // is undefined` fall-through (the pure-ESM Node path).
  it('returns false from a Node main-thread context', () => {
    expect(supportsSync()).toBe(false);
  });

  it('returns false when SharedArrayBuffer is unavailable', () => {
    const original = (globalThis as {SharedArrayBuffer?: unknown})
      .SharedArrayBuffer;
    (globalThis as {SharedArrayBuffer?: unknown}).SharedArrayBuffer =
      undefined;
    try {
      expect(supportsSync()).toBe(false);
    } finally {
      (globalThis as {SharedArrayBuffer?: unknown}).SharedArrayBuffer =
        original;
    }
  });

  it('returns false when Atomics is unavailable', () => {
    const original = (globalThis as {Atomics?: unknown}).Atomics;
    (globalThis as {Atomics?: unknown}).Atomics = undefined;
    try {
      expect(supportsSync()).toBe(false);
    } finally {
      (globalThis as {Atomics?: unknown}).Atomics = original;
    }
  });
});
