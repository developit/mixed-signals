/** The wire delta modes the server emits for incremental signal updates. */
export type DeltaMode = 'append' | 'merge' | 'splice';

/**
 * A single contiguous array edit: starting at `start`, delete `deleteCount`
 * existing items and insert `items` in their place. Mirrors the argument shape
 * of `Array.prototype.splice`.
 */
export interface SpliceDelta {
  start: number;
  deleteCount: number;
  items: readonly unknown[];
}
