import {Signal} from '@preact/signals-core';

/**
 * Each slot in a shape is one of:
 *   0 — plain JSON value (string, number, boolean, null, array, nested plain object)
 *   1 — a Signal (reconstructed on the receiver via @H with kind "s")
 *   2 — a nested handle (model, plain object, function, promise)
 */
export const SLOT_PLAIN = 0 as const;
export const SLOT_SIGNAL = 1 as const;
export const SLOT_HANDLE = 2 as const;

export type SlotKind =
  | typeof SLOT_PLAIN
  | typeof SLOT_SIGNAL
  | typeof SLOT_HANDLE;

export interface Shape {
  /** Ordered list of own enumerable keys (stripped of `_`-prefixed & non-serializable). */
  keys: string[];
  /** Slot classification, aligned with `keys`. */
  kinds: SlotKind[];
}

/** Classify a single value to a slot kind. */
export function classifySlot(value: unknown): SlotKind {
  if (value instanceof Signal) return SLOT_SIGNAL;
  if (value === null || value === undefined) return SLOT_PLAIN;
  const t = typeof value;
  if (t === 'function') return SLOT_HANDLE;
  if (t !== 'object') return SLOT_PLAIN;
  // Promises always become handles (pending or settled — the serializer decides).
  if (typeof (value as any).then === 'function') return SLOT_HANDLE;
  // Plain objects / arrays are PLAIN at the slot level; the serializer will
  // recurse into them and any Signals/handles encountered deeper will appear
  // inline as `@H` markers inside the plain JSON.
  return SLOT_PLAIN;
}

/**
 * Compute the shape of a non-null object. Skips `_`-prefixed keys. Function
 * properties are included — they become handle slots.
 */
export function shapeOf(value: Record<string, unknown>): Shape {
  const keys: string[] = [];
  const kinds: SlotKind[] = [];
  for (const key of Object.keys(value)) {
    if (key[0] === '_') continue;
    keys.push(key);
    kinds.push(classifySlot(value[key]));
  }
  return {keys, kinds};
}

/**
 * A canonical string signature for a shape, used as a cache key on the server.
 * The receiver never parses this — it only sees shape objects inline on first
 * use, keyed by numeric shapeId.
 */
export function shapeSignature(shape: Shape): string {
  // keys are already ordered; kinds are aligned. "key:kind|key:kind|…"
  let out = '';
  for (let i = 0; i < shape.keys.length; i++) {
    if (i) out += '|';
    out += shape.keys[i];
    out += ':';
    out += shape.kinds[i];
  }
  return out;
}
