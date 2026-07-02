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

/**
 * Deep read-only view of a value passed to an optimistic transform. Nested
 * reflected signals narrow to {@link ReadonlySignal} so the transform cannot
 * write the source, and functions are left intact.
 */
export type Immutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlySignal<infer V>
    ? ReadonlySignal<V>
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

interface PatchMeta {
  readonly id: number;
  readonly callId?: number;
  readonly onError?: (error: unknown) => void;
  readonly onConflict?: (conflict: OptimisticConflict) => void;
}

type LayerMeta = Omit<PatchMeta, 'id'>;

type Patch<T> =
  | (PatchMeta & {
      readonly kind: 'transform';
      readonly apply: (current: T) => T;
      readonly until?: (base: T) => boolean;
    })
  | (PatchMeta & {
      readonly kind: 'list';
      readonly ops: ListOp[];
      readonly key: KeyFn;
    });

let nextId = 1;

const overlays = new WeakMap<ReadonlySignal<unknown>, Overlay<unknown>>();

const callRegistry = new WeakMap<Promise<unknown>, number>();

/**
 * @internal Bind an action promise to the wire call id that will confirm it.
 * The RPC client calls this for every request.
 */
export function registerCall(action: Promise<unknown>, callId: number): void {
  callRegistry.set(action, callId);
}

/** Invoke a user callback without letting a throw escape into reconciliation. */
function safely(callback: (() => void) | undefined): void {
  if (!callback) return;
  try {
    callback();
  } catch {}
}

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

/**
 * @internal Key an untrusted server row, returning `undefined` (rather than
 * throwing, unlike {@link keyOf}) when the key function cannot key it.
 */
const tryKeyOf = (item: unknown, key: KeyFn): PropertyKey | undefined => {
  let value: unknown;
  try {
    value = key(item);
  } catch {
    return undefined;
  }
  return isPropertyKey(value) ? value : undefined;
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

/** @internal Build a key→index map (server base), skipping un-keyable rows. */
function buildIndex(arr: readonly unknown[], key: KeyFn): Map<PropertyKey, number> {
  const map = new Map<PropertyKey, number>();
  for (let i = 0; i < arr.length; i++) {
    const k = tryKeyOf(arr[i], key);
    if (k !== undefined && !map.has(k)) map.set(k, i);
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

  const arr: unknown[] = [];
  for (const it of current) {
    const k = tryKeyOf(it, key);
    if (k !== undefined && removals.has(k)) continue;
    arr.push(k !== undefined && replacements.has(k) ? replacements.get(k) : it);
  }

  // Moves before inserts: moved items reach their final relative order first so
  // inserts anchor against a settled neighbourhood.
  for (const op of ops) {
    if (op.type !== 'move') continue;
    const idx = arr.findIndex((it) => tryKeyOf(it, key) === op.key);
    if (idx === -1) continue;
    const [item] = arr.splice(idx, 1);
    arr.splice(positionFor(arr, op, key), 0, item);
  }

  for (const op of ops) {
    if (op.type !== 'insert') continue;
    // Already reflected by the server (same key present) -> don't double-insert.
    if (arr.some((it) => tryKeyOf(it, key) === op.key)) continue;
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
    const i = arr.findIndex((it) => tryKeyOf(it, key) === op.prevKey);
    if (i !== -1) pos = i + 1;
  }
  if (pos === -1 && op.nextKey != null) {
    const i = arr.findIndex((it) => tryKeyOf(it, key) === op.nextKey);
    if (i !== -1) pos = i;
  }
  if (pos === -1) pos = Math.min(op.index, arr.length);
  return pos;
}

/**
 * @internal Has the server base already reflected this keyed op? When
 * `confirmReplaceByValue` is false (the patch carries a mutation id, so it will
 * be confirmed by identity), a replace confirms only once the server value
 * equals the optimistic value or the key is gone — never on a mere divergence
 * from the pre-edit baseline, which could be a concurrent third-party write.
 */
function isConfirmed(
  op: ListOp,
  base: readonly unknown[],
  baseIndex: Map<PropertyKey, number>,
  confirmReplaceByValue: boolean,
): boolean {
  switch (op.type) {
    case 'insert':
      return baseIndex.has(op.key);
    case 'remove':
      return !baseIndex.has(op.key);
    case 'replace': {
      const i = baseIndex.get(op.key);
      if (i === undefined) return true;
      if (deepEqual(base[i], op.item)) return true;
      return confirmReplaceByValue && !deepEqual(base[i], op.before);
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
  private callbackQueue: Array<() => void> = [];
  private draining = false;

  constructor(private readonly signal: Signal<T>) {
    this.base = signal.peek();
  }

  private enqueue(callback: () => void): void {
    this.callbackQueue.push(callback);
  }

  /**
   * @internal Run queued user callbacks after patches, render, and detach have
   * committed. A callback that reenters a public overlay method (e.g.
   * `onConflict` calling `rollback`) only enqueues further callbacks; the
   * outermost loop drains them, so no reentrant call observes or overwrites
   * half-committed state.
   */
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.callbackQueue.length > 0) {
        const callback = this.callbackQueue.shift();
        safely(callback);
      }
    } finally {
      this.draining = false;
    }
  }

  private commit<R>(work: () => R): R {
    try {
      return work();
    } finally {
      this.drain();
    }
  }

  layer(apply: (current: T) => T, until: ((base: T) => boolean) | undefined, meta: LayerMeta): number {
    const id = nextId++;
    return this.commit(() => {
      this.patches.push({kind: 'transform', id, apply, until, ...meta});
      this.render();
      return id;
    });
  }

  layerKeyed(
    transform: (current: T) => T,
    key: KeyFn,
    actionBound: boolean,
    echoed: boolean,
    meta: LayerMeta,
  ): number {
    return this.commit(() => {
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
      if (echoed && ops.some((op) => op.type !== 'insert')) {
        throw new TypeError(
          'optimistic: echoed is the keyed-insert contract; it cannot be combined with a remove, replace, or move',
        );
      }
      const id = nextId++;
      this.patches.push({kind: 'list', id, ops, key, ...meta});
      this.render();
      return id;
    });
  }

  drop(id: number): void {
    const remaining = this.patches.filter((patch) => patch.id !== id);
    if (remaining.length === this.patches.length) return;
    this.patches = remaining;
    this.commit(() => this.render());
  }

  reset(): void {
    this.patches = [];
    this.detach();
  }

  foldServer(delta: unknown, mode: DeltaMode | undefined, callId?: number): void {
    this.commit(() => {
      const previousBase = this.base;
      this.base = applyDelta(this.base, delta, mode) as T;
      const base = asArray(this.base);
      const appended = mode === 'append' && Array.isArray(delta) ? (delta as unknown[]) : null;

      const remaining: Patch<T>[] = [];
      for (const patch of this.patches) {
        if (callId !== undefined && patch.callId === callId) continue;

        if (patch.callId !== undefined && patch.onConflict && callId !== patch.callId) {
          this.reportConflicts(patch, previousBase, this.base);
        }

        const kept =
          patch.kind === 'transform'
            ? this.reconcileTransform(patch)
            : this.reconcileList(patch, base, appended);
        if (kept) remaining.push(kept);
      }
      this.patches = remaining;
      this.render();
    });
  }

  private reconcileTransform(
    patch: Extract<Patch<T>, {kind: 'transform'}>,
  ): Patch<T> | null {
    if (!patch.until) return patch;
    try {
      return patch.until(this.base) ? null : patch;
    } catch (error) {
      this.enqueue(() => patch.onError?.(error));
      return null;
    }
  }

  private reconcileList(
    patch: Extract<Patch<T>, {kind: 'list'}>,
    base: unknown[],
    appended: unknown[] | null,
  ): Patch<T> | null {
    const baseIndex = buildIndex(base, patch.key);
    const appendedKeys = appended
      ? new Set(
          appended
            .map((it) => tryKeyOf(it, patch.key))
            .filter((k): k is PropertyKey => k !== undefined),
        )
      : null;
    const confirmReplaceByValue = patch.callId === undefined;
    const ops = patch.ops.filter((op) => {
      if (appendedKeys) {
        if (op.type === 'remove' || op.type === 'replace') return true;
        if (op.type === 'insert' && !appendedKeys.has(op.key)) return true;
      }
      return !isConfirmed(op, base, baseIndex, confirmReplaceByValue);
    });
    return ops.length > 0 ? {...patch, ops} : null;
  }

  private reportConflicts(patch: Patch<T>, previousBase: T, nextBase: T): void {
    const onConflict = patch.onConflict;
    if (!onConflict) return;

    if (patch.kind === 'transform') {
      if (isPlainObject(nextBase) || Array.isArray(nextBase)) return;
      if (deepEqual(previousBase, nextBase)) return;
      let optimistic: unknown;
      try {
        optimistic = patch.apply(nextBase);
      } catch {
        optimistic = undefined;
      }
      this.enqueue(() => onConflict({optimistic, server: nextBase}));
      return;
    }

    const previousArray = asArray(previousBase);
    const nextArray = asArray(nextBase);
    const previousIndex = buildIndex(previousArray, patch.key);
    const nextIndex = buildIndex(nextArray, patch.key);
    for (const op of patch.ops) {
      if (op.type !== 'replace') continue;
      const previousPos = previousIndex.get(op.key);
      const nextPos = nextIndex.get(op.key);
      if (previousPos === undefined || nextPos === undefined) continue;
      if (!deepEqual(previousArray[previousPos], nextArray[nextPos])) {
        this.enqueue(() => onConflict({key: op.key, optimistic: op.item, server: nextArray[nextPos]}));
      }
    }
  }

  /**
   * Fold every patch over the hidden base. A patch that throws is dropped and
   * reported through `onError` rather than propagated, so one poisoned patch
   * cannot wedge the transport read loop for a server-owned signal.
   */
  private project(): T {
    let current = this.base;
    let failed: Patch<T>[] | undefined;
    for (const patch of this.patches) {
      try {
        current =
          patch.kind === 'transform'
            ? patch.apply(current)
            : (applyListOps(asArray(current), patch.ops, patch.key) as T);
      } catch (error) {
        (failed ??= []).push(patch);
        this.enqueue(() => patch.onError?.(error));
      }
    }
    if (failed) {
      this.patches = this.patches.filter((patch) => !failed.includes(patch));
    }
    return current;
  }

  private render(): void {
    const projected = this.project();
    if (this.patches.length === 0) {
      this.detach();
      return;
    }
    this.signal.value = projected;
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
  callId?: number,
): boolean {
  const overlay = overlays.get(signal);
  if (!overlay) return false;
  overlay.foldServer(delta, mode, callId);
  return true;
}

/**
 * Per-change options. Array changes require a primitive, unique `key` so inserts,
 * removes, replaces, and moves reconcile by element identity rather than by
 * position; for keyed inserts the key must also appear on the eventual server
 * item (commonly an echoed client-mutation-id). Non-array changes may pass
 * `until` for source-driven reconciliation. The two are mutually exclusive.
 */
export type ChangeOptions<T> = [T] extends [ReadonlyArray<unknown>]
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

/**
 * Concrete, non-conditional view of {@link ChangeOptions} used internally.
 * `key` is row-agnostic here (it is applied to untrusted server rows through
 * {@link tryKeyOf}), and `until` reads the server-owned base.
 */
interface RecordOptions<T> {
  readonly key?: KeyFn;
  readonly echoed?: boolean;
  readonly until?: (base: T) => boolean;
}

/** Resolve the value-discriminated {@link ChangeOptions} conditional, which TS cannot narrow generically. Field legality is enforced by the public signatures. */
const asRecordOptions = <T>(options: object): RecordOptions<T> =>
  options as RecordOptions<T>;

/** A mutable value satisfies its own readonly view; TS cannot prove this widening for a generic `T`. */
const asImmutable = <T>(value: T): Immutable<T> => value as Immutable<T>;

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

/**
 * Lifecycle of an optimistic transaction. A transport-closed rejection on
 * reconnect surfaces as `failed`.
 */
export type OptimisticState = 'pending' | 'settled' | 'failed' | 'rolledback';

/**
 * A divergent write reached a key or scalar this transaction is still holding
 * optimistically. The optimistic value keeps shadowing until the change is
 * confirmed; this only reports the divergence. Reported for list `replace` ops
 * and scalar values, never for object-valued transforms, whose owned fields are
 * unknown. Telling a genuine concurrent write apart from the server normalizing
 * this caller's own edit relies on the server echoing mutation ids: against a
 * server that does not echo them, the caller's own untagged confirming delta can
 * also surface here.
 */
export interface OptimisticConflict {
  /** The key of the changed list item, or `undefined` for a scalar. */
  readonly key?: PropertyKey;
  /** The value this transaction optimistically wrote. */
  readonly optimistic: unknown;
  /** The concurrent value the server now holds. */
  readonly server: unknown;
}

/** Optional observability callbacks for an optimistic transaction. */
export interface OptimisticOptions {
  /** Runs once after a successful action reconciles to server truth. */
  onSettle?: () => void;
  /**
   * Runs when applying a change to the (concurrently moving) server value
   * throws. The change is dropped and reported here rather than crashing the
   * delta pipeline. May fire more than once.
   */
  onError?: (error: unknown) => void;
  /**
   * Runs when a divergent write reaches a key or scalar this transaction still
   * holds. Only fires for a change bound to an action whose wire id the server
   * echoes: reliable discrimination of a true concurrent write needs that echo,
   * and without it this can also fire for the caller's own normalized edit. A
   * change with no bound action never reports. May fire more than once.
   */
  onConflict?: (conflict: OptimisticConflict) => void;
}

/** Controls a live optimistic transaction. */
export interface OptimisticHandle {
  /** Drop the optimistic changes and reconcile to the server-owned value. */
  rollback(): void;
  /** Current lifecycle state. */
  readonly state: OptimisticState;
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
  options?: OptimisticOptions,
): OptimisticHandle {
  const settleDrops: Array<() => void> = [];
  const failureDrops: Array<() => void> = [];
  const meta: LayerMeta = {
    callId: action ? callRegistry.get(action) : undefined,
    onError: options?.onError,
    onConflict: options?.onConflict,
  };

  const record = <T>(
    signal: ReflectedSignal<T>,
    transform: (current: T) => T,
    options: RecordOptions<T>,
  ): void => {
    const source = signal[SOURCE];
    const overlay = overlayFor(source);

    if (options.key) {
      const echoed = options.echoed === true;
      const id = overlay.layerKeyed(transform, options.key, action !== undefined, echoed, meta);
      (echoed ? failureDrops : settleDrops).push(() => overlay.drop(id));
      return;
    }

    const current = source.peek();
    const produced = transform(current);
    if (Array.isArray(current) || Array.isArray(produced)) {
      throw new TypeError('optimistic: array changes require a key option');
    }
    const id = overlay.layer(transform, options.until, meta);
    settleDrops.push(() => overlay.drop(id));
  };

  const dropAll = (...lists: Array<Array<() => void>>): void => {
    batch(() => {
      for (const list of lists) for (const drop of list) drop();
    });
  };

  let state: OptimisticState = 'pending';
  const transition = (next: OptimisticState): boolean => {
    if (state !== 'pending') return false;
    state = next;
    return true;
  };

  action?.then(
    () => {
      if (!transition('settled')) return;
      dropAll(settleDrops);
      safely(options?.onSettle);
    },
    () => {
      if (!transition('failed')) return;
      dropAll(settleDrops, failureDrops);
    },
  );

  try {
    batch(() => {
      apply({
        set: ({signal, value, ...rest}) =>
          record(signal, () => value, asRecordOptions(rest)),
        update: ({signal, transform, ...rest}) =>
          record(signal, (current) => transform(asImmutable(current)), asRecordOptions(rest)),
      });
    });
  } catch (error) {
    dropAll(settleDrops, failureDrops);
    state = 'failed';
    throw error;
  }

  const rollback = () => {
    if (!transition('rolledback')) return;
    dropAll(settleDrops, failureDrops);
  };

  return {
    rollback,
    get state() {
      return state;
    },
  };
}
