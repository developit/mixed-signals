/**
 * A "shape" is the compressed description of an `o` handle's data slots.
 * We track two kinds:
 *
 *   0 — everything non-signal (plain JSON, nested `@H` handle, arrays, …)
 *   1 — a Signal slot (the hydrator materializes a live `Signal` there)
 *
 * That's the entire classification. Methods never appear in a shape —
 * they're dispatched via the Proxy trap, not carried as data.
 */
export const SLOT_OTHER = 0 as const;
export const SLOT_SIGNAL = 1 as const;

export type SlotKind = typeof SLOT_OTHER | typeof SLOT_SIGNAL;

export interface Shape {
  /** Ordered list of own enumerable non-`_`, non-function keys. */
  keys: string[];
  /** One slot tag per key. */
  kinds: SlotKind[];
}

/** A canonical string signature, used as a shape-cache key on the sender. */
export function shapeSignature(shape: Shape): string {
  let out = '';
  for (let i = 0; i < shape.keys.length; i++) {
    if (i) out += '|';
    out += shape.keys[i];
    out += ':';
    out += shape.kinds[i];
  }
  return out;
}
