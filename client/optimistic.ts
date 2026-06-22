import {batch, type ReadonlySignal, Signal} from '@preact/signals-core';
import type {DeltaMode, SpliceDelta} from '../shared/delta.ts';

export type {DeltaMode};

/**
 * Global-registry symbol so the brand survives duplicate copies of the package
 * (dual ESM/CJS, multiple versions in one bundle) — a module-local `Symbol()`
 * would make copy A fail to recognize copy B's reflected signals.
 */
const SOURCE: unique symbol = Symbol.for('mixed-signals/reflected');

/**
 * A reflected, server-owned signal that the UI renders read-only but may be
 * mutated optimistically through {@link optimistic}. The brand is nominal:
 * only signals produced by the reflection layer satisfy it, so passing a plain
 * local signal is a compile error. `T` is invariant (`in out`), so a
 * wider/narrower view cannot be substituted to smuggle a mistyped write into
 * the source.
 */
export interface ReflectedSignal<in out T> extends ReadonlySignal<T> {
  readonly [SOURCE]: Signal<T>;
}

/** @internal */
export function linkSource<T>(
  facade: ReadonlySignal<T>,
  source: Signal<T>,
): ReflectedSignal<T> {
  (facade as ReadonlySignal<T> & {[SOURCE]: Signal<T>})[SOURCE] = source;
  return facade as ReflectedSignal<T>;
}

/**
 * Refine a signal to the reflected (server-owned) brand so it can be written
 * optimistically via {@link optimistic}. Signals produced by the reflection
 * layer carry the brand at runtime; this verifies it and narrows the static
 * type, throwing if the signal is a plain local one.
 *
 * Use it when a reflected signal is typed more loosely than its runtime brand —
 * e.g. a generated transport interface that describes the signal as a plain
 * {@link Signal}/{@link ReadonlySignal} because the generator predates the
 * brand. This is a checked narrowing, not a blind cast: misuse fails fast
 * instead of producing an inert overlay.
 */
export function asReflected<T>(signal: ReadonlySignal<T>): ReflectedSignal<T> {
  if (!(SOURCE in signal)) {
    throw new TypeError(
      'asReflected: expected a reflected signal from createReflectedModel, received a plain signal',
    );
  }
  return signal as ReflectedSignal<T>;
}

type Immutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlySignal<unknown>
    ? T
    : T extends string | number | boolean | bigint | symbol | null | undefined
      ? T
      : T extends ReadonlyMap<infer K, infer V>
        ? ReadonlyMap<Immutable<K>, Immutable<V>>
        : T extends ReadonlySet<infer V>
          ? ReadonlySet<Immutable<V>>
          : T extends object
            ? {readonly [K in keyof T]: Immutable<T[K]>}
            : T;

/** @internal Narrows a raw wire mode string to a known delta mode. */
export function coerceDeltaMode(mode: string | undefined): DeltaMode | undefined {
  return mode === 'append' || mode === 'merge' || mode === 'splice'
    ? mode
    : undefined;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSpliceDelta = (value: unknown): value is SpliceDelta =>
  isPlainObject(value) &&
  Number.isInteger(value.start) &&
  Number.isInteger(value.deleteCount) &&
  Array.isArray(value.items);

/**
 * @internal Reconstructs a value from a wire delta. Element and field types are
 * trusted from the server; a delta whose shape does not fit the mode is ignored.
 */
export function applyDelta(
  current: unknown,
  delta: unknown,
  mode: DeltaMode | undefined,
): unknown {
  switch (mode) {
    case 'append':
      if (Array.isArray(current) && Array.isArray(delta)) {
        return [...current, ...delta];
      }
      if (typeof current === 'string' && typeof delta === 'string') {
        return current + delta;
      }
      return current;
    case 'merge':
      if (isPlainObject(current) && isPlainObject(delta)) {
        return {...current, ...delta};
      }
      return current;
    case 'splice':
      if (Array.isArray(current) && isSpliceDelta(delta)) {
        const next = current.slice();
        next.splice(delta.start, delta.deleteCount, ...delta.items);
        return next;
      }
      return current;
    default:
      return delta;
  }
}

/** @internal A keyed list mutation derived from a snapshot->optimistic diff. */
type ListOp =
  | {
      readonly type: 'insert';
      readonly key: PropertyKey;
      readonly item: unknown;
      readonly prevKey: PropertyKey | null;
      readonly nextKey: PropertyKey | null;
      readonly index: number;
    }
  | {readonly type: 'remove'; readonly key: PropertyKey}
  | {
      readonly type: 'replace';
      readonly key: PropertyKey;
      readonly item: unknown;
      /** Pre-edit value, so the op confirms once the server diverges from it. */
      readonly before: unknown;
    }
  | {
      readonly type: 'move';
      readonly key: PropertyKey;
      readonly prevKey: PropertyKey | null;
      readonly nextKey: PropertyKey | null;
      readonly index: number;
    };

type KeyFn = (item: unknown) => PropertyKey;

/**
 * A transform patch keeps the original opaque closure (scalars, objects, and
 * keyless transforms). A list patch stores keyed operations derived from a
 * snapshot diff, so reconciliation is per-item by identity rather than by
 * re-running an append closure over a moving base.
 */
type Patch<T> =
  | {
      readonly kind: 'transform';
      readonly id: number;
      readonly apply: (current: T) => T;
      readonly until?: (base: T) => boolean;
    }
  | {readonly kind: 'list'; readonly id: number; readonly ops: ListOp[]; readonly key: KeyFn};

let nextId = 1;

const overlays = new WeakMap<ReadonlySignal<unknown>, Overlay<unknown>>();

const isPropertyKey = (value: unknown): value is PropertyKey =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'symbol';

const keyOf = (item: unknown, key: KeyFn): PropertyKey => {
  const value = key(item);
  if (!isPropertyKey(value)) {
    throw new TypeError(
      'optimistic: array keys must be primitive string, number, or symbol values',
    );
  }
  return value;
};

/** @internal Build a key→index map, throwing on duplicate keys (optimistic diff). */
function buildUniqueIndex(arr: readonly unknown[], key: KeyFn): Map<PropertyKey, number> {
  const map = new Map<PropertyKey, number>();
  for (let i = 0; i < arr.length; i++) {
    const k = keyOf(arr[i], key);
    if (map.has(k)) {
      throw new TypeError('optimistic: array keys must be unique');
    }
    map.set(k, i);
  }
  return map;
}

/** @internal Build a key→index map without asserting uniqueness (server base). */
function buildIndex(arr: readonly unknown[], key: KeyFn): Map<PropertyKey, number> {
  const map = new Map<PropertyKey, number>();
  for (let i = 0; i < arr.length; i++) {
    const k = keyOf(arr[i], key);
    if (!map.has(k)) map.set(k, i);
  }
  return map;
}

/** @internal Neighbour keys of position `idx`, or null at the edges. */
function neighbourKeys(
  arr: readonly unknown[],
  idx: number,
  key: KeyFn,
): {prevKey: PropertyKey | null; nextKey: PropertyKey | null} {
  return {
    prevKey: idx > 0 ? keyOf(arr[idx - 1], key) : null,
    nextKey: idx < arr.length - 1 ? keyOf(arr[idx + 1], key) : null,
  };
}

const isSignalLike = (value: unknown): value is {peek(): unknown} =>
  value instanceof Signal ||
  (typeof value === 'object' &&
    value !== null &&
    typeof (value as {peek?: unknown}).peek === 'function' &&
    typeof (value as {subscribe?: unknown}).subscribe === 'function');

function deepEqual(a: unknown, b: unknown): boolean {
  if (isSignalLike(a) || isSignalLike(b)) {
    return deepEqual(isSignalLike(a) ? a.peek() : a, isSignalLike(b) ? b.peek() : b);
  }
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** @internal Indices (into `seq`) of one longest strictly-increasing subsequence. */
function longestIncreasingSubsequence(seq: readonly number[]): number[] {
  const n = seq.length;
  if (n === 0) return [];
  const parent = new Array<number>(n).fill(-1);
  const tails: number[] = []; // tails[l] = index in seq of the smallest tail of an LIS of length l+1
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) parent[i] = tails[lo - 1];
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }
  const result: number[] = [];
  let k = tails[tails.length - 1];
  while (k !== -1) {
    result.push(k);
    k = parent[k];
  }
  return result.reverse();
}

/** @internal Snapshot diff: what keyed ops turn `before` into `after`. */
export function diffByKey(
  before: readonly unknown[],
  after: readonly unknown[],
  key: KeyFn,
): ListOp[] {
  const beforeIndex = buildUniqueIndex(before, key);
  const afterIndex = buildUniqueIndex(after, key);

  const ops: ListOp[] = [];

  for (let i = 0; i < before.length; i++) {
    const k = keyOf(before[i], key);
    if (!afterIndex.has(k)) ops.push({type: 'remove', key: k});
  }

  for (let i = 0; i < after.length; i++) {
    const it = after[i];
    const k = keyOf(it, key);
    const beforePos = beforeIndex.get(k);
    if (beforePos === undefined) {
      const {prevKey, nextKey} = neighbourKeys(after, i, key);
      ops.push({type: 'insert', key: k, item: it, prevKey, nextKey, index: i});
    } else if (!deepEqual(before[beforePos], it)) {
      ops.push({type: 'replace', key: k, item: it, before: before[beforePos]});
    }
  }

  // Moves: items present in both, whose relative order changed. A longest
  // increasing subsequence of before-indices (taken in after-order) marks the
  // items that kept their relative order; the rest genuinely moved. This stays
  // correct alongside inserts/removes (which merely shift neighbours).
  const common: {key: PropertyKey; beforeIdx: number; afterIdx: number}[] = [];
  for (let i = 0; i < after.length; i++) {
    const k = keyOf(after[i], key);
    const beforePos = beforeIndex.get(k);
    if (beforePos !== undefined) common.push({key: k, beforeIdx: beforePos, afterIdx: i});
  }
  const stable = new Set(longestIncreasingSubsequence(common.map((c) => c.beforeIdx)));
  for (let j = 0; j < common.length; j++) {
    if (stable.has(j)) continue;
    const c = common[j];
    const {prevKey, nextKey} = neighbourKeys(after, c.afterIdx, key);
    ops.push({type: 'move', key: c.key, prevKey, nextKey, index: c.afterIdx});
  }

  return ops;
}

/** @internal Replay keyed ops onto the current value, positioned by neighbour key. */
export function applyListOps(
  current: readonly unknown[],
  ops: readonly ListOp[],
  key: KeyFn,
): unknown[] {
  const replacements = new Map<PropertyKey, unknown>();
  const removals = new Set<PropertyKey>();
  for (const op of ops) {
    if (op.type === 'replace') replacements.set(op.key, op.item);
    else if (op.type === 'remove') removals.add(op.key);
  }

  let arr: unknown[] = [];
  for (const it of current) {
    const k = keyOf(it, key);
    if (removals.has(k)) continue;
    arr.push(replacements.has(k) ? replacements.get(k) : it);
  }

  // Moves before inserts: moved items reach their final relative order first so
  // inserts anchor against a settled neighbourhood.
  for (const op of ops) {
    if (op.type !== 'move') continue;
    const idx = arr.findIndex((it) => keyOf(it, key) === op.key);
    if (idx === -1) continue;
    const [item] = arr.splice(idx, 1);
    arr.splice(positionFor(arr, op, key), 0, item);
  }

  for (const op of ops) {
    if (op.type !== 'insert') continue;
    // Already reflected by the server (same key present) -> don't double-insert.
    if (arr.some((it) => keyOf(it, key) === op.key)) continue;
    arr.splice(positionFor(arr, op, key), 0, op.item);
  }

  return arr;
}

function positionFor(
  arr: readonly unknown[],
  op: Extract<ListOp, {type: 'insert' | 'move'}>,
  key: KeyFn,
): number {
  let pos = -1;
  if (op.prevKey != null) {
    const i = arr.findIndex((it) => keyOf(it, key) === op.prevKey);
    if (i !== -1) pos = i + 1;
  }
  if (pos === -1 && op.nextKey != null) {
    const i = arr.findIndex((it) => keyOf(it, key) === op.nextKey);
    if (i !== -1) pos = i;
  }
  if (pos === -1) pos = Math.min(op.index, arr.length);
  return pos;
}

/** @internal Has the server base already reflected this keyed op? */
function isConfirmed(
  op: ListOp,
  base: readonly unknown[],
  baseIndex: Map<PropertyKey, number>,
): boolean {
  switch (op.type) {
    case 'insert':
      return baseIndex.has(op.key);
    case 'remove':
      return !baseIndex.has(op.key);
    case 'replace': {
      const i = baseIndex.get(op.key);
      if (i === undefined) return true; // key gone from the server -> settled
      // Confirmed once the server has written anything different from the
      // pre-edit baseline at this key — covers server-side normalization where
      // the stored item never deep-equals the optimistic guess.
      return !deepEqual(base[i], op.before);
    }
    case 'move':
      return hasRelativeOrder(op, baseIndex);
  }
}

/**
 * @internal A move confirms once the item sits on the correct side of whichever
 * anchors the server currently has. Absent anchors impose no constraint, so the
 * move still confirms at list edges or under concurrent edits.
 */
function hasRelativeOrder(
  op: Extract<ListOp, {type: 'move'}>,
  baseIndex: Map<PropertyKey, number>,
): boolean {
  const i = baseIndex.get(op.key);
  if (i === undefined) return false;
  if (op.prevKey != null) {
    const p = baseIndex.get(op.prevKey);
    if (p !== undefined && !(p < i)) return false;
  }
  if (op.nextKey != null) {
    const n = baseIndex.get(op.nextKey);
    if (n !== undefined && !(i < n)) return false;
  }
  return true;
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

class Overlay<T> {
  private base: T;
  private patches: Patch<T>[] = [];

  constructor(private readonly signal: Signal<T>) {
    this.base = signal.peek();
  }

  layer(apply: (current: T) => T, until?: (base: T) => boolean): number {
    const id = nextId++;
    this.patches.push({kind: 'transform', id, apply, until});
    this.render();
    return id;
  }

  /** Snapshot the current projection, run the transform, store the keyed diff. */
  layerKeyed(transform: (current: T) => T, key: KeyFn, actionBound: boolean): number {
    const current = this.project();
    const after = transform(current);
    if (!Array.isArray(after)) {
      throw new TypeError('optimistic: keyed array transforms must return an array');
    }
    const before = asArray(current);
    const ops = diffByKey(before, after, key);
    if (!actionBound && ops.some((op) => op.type === 'insert')) {
      throw new TypeError(
        'optimistic: keyed inserts require an action promise so unconfirmed inserts can settle or roll back',
      );
    }
    const id = nextId++;
    this.patches.push({kind: 'list', id, ops, key});
    this.render();
    return id;
  }

  drop(id: number): void {
    const remaining = this.patches.filter((patch) => patch.id !== id);
    if (remaining.length === this.patches.length) return;
    this.patches = remaining;
    if (remaining.length === 0) this.detach();
    else this.render();
  }

  reset(): void {
    this.patches = [];
    this.detach();
  }

  foldServer(delta: unknown, mode: DeltaMode | undefined): void {
    this.base = applyDelta(this.base, delta, mode) as T;
    const base = asArray(this.base);
    // Append-only fast path: only inserts (newly-present keys) and moves can
    // change confirmation status; removes/replaces never confirm on an append.
    const appended = mode === 'append' && Array.isArray(delta) ? (delta as unknown[]) : null;

    const remaining: Patch<T>[] = [];
    for (const patch of this.patches) {
      if (patch.kind === 'transform') {
        if (!patch.until?.(this.base)) remaining.push(patch);
        continue;
      }
      const baseIndex = buildIndex(base, patch.key);
      const appendedKeys = appended
        ? new Set(appended.map((it) => keyOf(it, patch.key)))
        : null;
      const ops = patch.ops.filter((op) => {
        if (appendedKeys) {
          if (op.type === 'remove' || op.type === 'replace') return true;
          if (op.type === 'insert' && !appendedKeys.has(op.key)) return true;
        }
        return !isConfirmed(op, base, baseIndex);
      });
      if (ops.length > 0) remaining.push({...patch, ops});
    }
    this.patches = remaining;
    if (this.patches.length === 0) {
      this.detach();
      return;
    }
    this.render();
  }

  private project(): T {
    let current = this.base;
    for (const patch of this.patches) {
      current =
        patch.kind === 'transform'
          ? patch.apply(current)
          : (applyListOps(asArray(current), patch.ops, patch.key) as T);
    }
    return current;
  }

  private render(): void {
    this.signal.value = this.project();
  }

  private detach(): void {
    if (this.signal.peek() !== this.base) this.signal.value = this.base;
    overlays.delete(this.signal);
  }
}

function overlayFor<T>(source: Signal<T>): Overlay<T> {
  const existing = overlays.get(source);
  if (existing) return existing as Overlay<T>;
  const created = new Overlay(source);
  overlays.set(source, created as Overlay<unknown>);
  return created;
}

/** @internal Roll back a live optimistic overlay, used when reflection resets. */
export function resetOptimisticOverlay(signal: ReadonlySignal<unknown>): void {
  overlays.get(signal)?.reset();
}

/** @internal Routes a wire delta into an active overlay's hidden server base. */
export function applyServerUpdate(
  signal: ReadonlySignal<unknown>,
  delta: unknown,
  mode: DeltaMode | undefined,
): boolean {
  const overlay = overlays.get(signal);
  if (!overlay) return false;
  overlay.foldServer(delta, mode);
  return true;
}

/**
 * Per-change options. Array changes require a primitive, unique `key` so inserts,
 * removes, replaces, and moves reconcile by element identity rather than by
 * position; for keyed inserts the key must also appear on the eventual server
 * item (commonly an echoed client-mutation-id). Non-array changes may pass
 * `until` for source-driven reconciliation. The two are mutually exclusive.
 */
type ChangeOptions<T> = T extends ReadonlyArray<unknown>
  ? {
      key: (item: Immutable<T[number]>) => PropertyKey;
      /**
       * Declare that the server echoes this change's `key` on the real item — the
       * documented keyed-insert contract. Reconciliation is then strictly
       * source-driven: the provisional item stays until the server reflects the
       * key (confirmed in the same delta, flicker-free), and a *successful* action
       * never rolls it back. This matters when the action settles before the echo
       * arrives (e.g. an action that resolves once the work is accepted and streams
       * the echoing delta afterwards): without it, the settling action drops the
       * provisional item for a frame until the echo re-adds it — a flash. The
       * action's *rejection* still rolls the change back.
       *
       * Leave unset (default) for keys the server does not echo: there the action's
       * settlement cleans up an unconfirmed insert (a one-frame duplicate may show),
       * which is the safe behaviour when no echo is coming.
       */
      echoed?: boolean;
      until?: never;
    }
  : {
      echoed?: never;
      /**
       * Reconcile as soon as the server-owned value satisfies the predicate —
       * i.e. the change is now reflected in the source — instead of waiting for
       * the bound action to settle. Runs against the hidden server base after
       * each delta; returning `true` drops the patch in the same update, so the
       * swap to server truth is flicker-free. A delta that fails the predicate
       * leaves the patch in place.
       */
      until?: (serverValue: Immutable<T>) => boolean;
      key?: never;
    };

/** Arguments for {@link OptimisticTransaction.update}. */
export type UpdateArgs<T> = {
  signal: ReflectedSignal<T>;
  /** Pure transform: it may read `current` but must not mutate it. */
  transform: (current: Immutable<T>) => T;
} & ChangeOptions<T>;

/** Arguments for {@link OptimisticTransaction.set}. */
export type SetArgs<T> = {
  signal: ReflectedSignal<T>;
  value: T;
} & ChangeOptions<T>;

/** Records optimistic changes against reflected signals within a transaction. */
export interface OptimisticTransaction {
  /**
   * Replace a reflected signal's value optimistically. Array values require a
   * `key`; for keyed inserts the key must also appear on the eventual server
   * item, or a one-frame duplicate may show until the bound action settles.
   */
  set<T>(args: SetArgs<T>): void;
  /**
   * Derive a reflected signal's next value from its current (read-only) one.
   * Array values require a `key`; for keyed inserts the key must also appear on
   * the eventual server item, or a one-frame duplicate may show until the bound
   * action settles.
   */
  update<T>(args: UpdateArgs<T>): void;
}

/** Controls a live optimistic transaction. */
export interface OptimisticHandle {
  /** Drop the optimistic changes and reconcile to the server-owned value. */
  rollback(): void;
}

/**
 * Apply an optimistic change to the reflected signals the UI already renders,
 * bound to the promise of the action that will make it real. Nothing is
 * declared ahead of time: each change is layered over the live signal while
 * server deltas keep updating a hidden base, and the overlay reconciles to the
 * server-owned value once `action` settles.
 *
 * Array changes require a primitive, unique `key`; each keyed
 * insert/remove/replace/move reconciles independently the moment the server
 * base reflects it. For keyed inserts the key must also appear on the eventual
 * server item (commonly an echoed client-mutation-id); otherwise a one-frame
 * duplicate may show until `action` settles and rolls the provisional item back.
 *
 * For non-array values, reconciliation assumes the server pushes the reflecting
 * delta around the same time it replies (as the bundled `RPC` does). When the
 * reply does not coincide with the delta, pass `until` so the change reconciles
 * the moment the server reflects it. Without an `action`, reconcile manually
 * with {@link OptimisticHandle.rollback}.
 */
export function optimistic(
  action: Promise<unknown> | undefined,
  apply: (tx: OptimisticTransaction) => void,
): OptimisticHandle {
  const settleDrops: Array<() => void> = [];
  const failureDrops: Array<() => void> = [];

  type RecordOptions = {key?: KeyFn; echoed?: boolean; until?: (base: any) => boolean};

  // Internal recorder. Typed with `any` for the value because the public
  // `ReflectedSignal<T>` is invariant, which would otherwise block inference
  // here; the public `set`/`update` signatures keep the call sites type-safe.
  const record = (
    signal: ReflectedSignal<any>,
    transform: (current: any) => any,
    options: RecordOptions,
  ): void => {
    const source = signal[SOURCE];
    const overlay = overlayFor(source);

    if (options.key) {
      const id = overlay.layerKeyed(transform, options.key, action !== undefined);
      (options.echoed ? failureDrops : settleDrops).push(() => overlay.drop(id));
      return;
    }

    // Keyless path: forbid arrays, classified by both the current value and the
    // value the transform produces (so a null/scalar base that becomes an array
    // cannot bypass the key requirement).
    const current = source.peek();
    const produced = transform(current);
    if (Array.isArray(current) || Array.isArray(produced)) {
      throw new TypeError('optimistic: array changes require a key option');
    }
    const id = overlay.layer(transform, options.until);
    settleDrops.push(() => overlay.drop(id));
  };

  const dropAll = (...lists: Array<Array<() => void>>): void => {
    batch(() => {
      for (const list of lists) for (const drop of list) drop();
    });
  };

  batch(() => {
    try {
      apply({
        set: ({signal, value, ...options}) =>
          record(signal, () => value, options as RecordOptions),
        update: ({signal, transform, ...options}) =>
          record(signal, (current) => transform(current), options as RecordOptions),
      });
    } catch (error) {
      // Atomicity: roll back any ops recorded before the callback threw so the
      // overlay is never left stuck without a handle to clear it.
      dropAll(settleDrops, failureDrops);
      throw error;
    }
  });

  const rollback = () => dropAll(settleDrops, failureDrops);

  action?.then(
    () => dropAll(settleDrops),
    () => dropAll(settleDrops, failureDrops),
  );

  return {rollback};
}
