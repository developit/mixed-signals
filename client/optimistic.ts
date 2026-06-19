import { batch, type ReadonlySignal, type Signal } from '@preact/signals-core';

const SOURCE = Symbol('mixed-signals.reflected');
declare const INVARIANT: unique symbol;

/**
 * A reflected, server-owned signal that the UI renders read-only but may be
 * mutated optimistically through {@link optimistic}. The brand is nominal:
 * only signals produced by the reflection layer satisfy it, so passing a plain
 * local signal is a compile error. `T` is invariant, so a wider/narrower view
 * cannot be substituted to smuggle a mistyped write into the source.
 */
export interface ReflectedSignal<T> extends ReadonlySignal<T> {
  readonly [SOURCE]: Signal<T>;
  readonly [INVARIANT]: (value: T) => T;
}

/** @internal */
export function linkSource<T>(
  facade: ReadonlySignal<T>,
  source: Signal<T>,
): ReflectedSignal<T> {
  (facade as ReadonlySignal<T> & { [SOURCE]: Signal<T> })[SOURCE] = source;
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
  : T extends ReadonlyMap<infer K, infer V>
  ? ReadonlyMap<Immutable<K>, Immutable<V>>
  : T extends ReadonlySet<infer V>
  ? ReadonlySet<Immutable<V>>
  : T extends ReadonlyArray<infer E>
  ? ReadonlyArray<Immutable<E>>
  : T extends object
  ? { readonly [K in keyof T]: Immutable<T[K]> }
  : T;

/** @internal The wire delta modes the server emits. */
export type DeltaMode = 'append' | 'merge' | 'splice';

/** @internal Narrows a raw wire mode string to a known delta mode. */
export function coerceDeltaMode(mode: string | undefined): DeltaMode | undefined {
  return mode === 'append' || mode === 'merge' || mode === 'splice'
    ? mode
    : undefined;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface SpliceDelta {
  start: number;
  deleteCount: number;
  items: readonly unknown[];
}

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
        return { ...current, ...delta };
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

interface Patch<T> {
  readonly id: number;
  readonly apply: (current: T) => T;
  readonly until?: (base: T) => boolean;
}

let nextId = 1;

const overlays = new WeakMap<ReadonlySignal<unknown>, Overlay<unknown>>();

class Overlay<T> {
  private base: T;
  private patches: Patch<T>[] = [];

  constructor(private readonly signal: Signal<T>) {
    this.base = signal.peek();
  }

  layer(apply: (current: T) => T, until?: (base: T) => boolean): number {
    const id = nextId++;
    this.patches.push({ id, apply, until });
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

  foldServer(delta: unknown, mode: DeltaMode | undefined): void {
    this.base = applyDelta(this.base, delta, mode) as T;
    const remaining = this.patches.filter((patch) => !patch.until?.(this.base));
    if (remaining.length !== this.patches.length) {
      this.patches = remaining;
      if (remaining.length === 0) {
        this.detach();
        return;
      }
    }
    this.render();
  }

  private render(): void {
    this.signal.value = this.patches.reduce(
      (current, patch) => patch.apply(current),
      this.base,
    );
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

/** Per-change options for an optimistic {@link OptimisticTransaction} operation. */
export interface OptimisticChangeOptions<T> {
  /**
   * Reconcile this change as soon as the server-owned value satisfies the
   * predicate — i.e. the change is now reflected in the source — instead of
   * waiting for the bound action to settle. The predicate runs against the
   * server value (the hidden base, never the optimistic overlay) after each
   * incoming delta; returning `true` drops the patch in the same update, so the
   * swap to server truth is flicker-free. A delta that fails the predicate
   * leaves the patch in place, so a stale or unrelated delta cannot drop a
   * pending change.
   */
  until?: (serverValue: Immutable<T>) => boolean;
}

/** Records optimistic changes against reflected signals within a transaction. */
export interface OptimisticTransaction {
  /** Replace a reflected signal's value optimistically. */
  set<T>(
    signal: ReflectedSignal<T>,
    value: T,
    options?: OptimisticChangeOptions<T>,
  ): void;
  /**
   * Derive a reflected signal's next value from its current (read-only) one.
   * The transform must be pure: it may read `current` but must not mutate it.
   */
  update<T>(
    signal: ReflectedSignal<T>,
    transform: (current: Immutable<T>) => T,
    options?: OptimisticChangeOptions<T>,
  ): void;
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
 * By default the overlay reconciles to the server-owned value once `action`
 * settles, assuming the server pushes the reflecting delta around the same time
 * it replies (as the bundled `RPC` does). When the reply does not coincide with
 * the reflecting delta — e.g. an RPC that resolves at the end of a longer
 * operation — pass {@link OptimisticChangeOptions.until} so the change instead
 * reconciles the moment the server reflects it, independent of the action.
 * Without either, reconcile manually with {@link OptimisticHandle.rollback}.
 */
export function optimistic(
  action: Promise<unknown> | undefined,
  apply: (tx: OptimisticTransaction) => void,
): OptimisticHandle {
  const drops: Array<() => void> = [];

  const record = <T>(
    signal: ReflectedSignal<T>,
    transform: (current: T) => T,
    until?: (serverValue: Immutable<T>) => boolean,
  ): void => {
    const overlay = overlayFor(signal[SOURCE]);
    const id = overlay.layer(transform, until as ((base: T) => boolean) | undefined);
    drops.push(() => overlay.drop(id));
  };

  batch(() =>
    apply({
      set: (signal, value, options) => record(signal, () => value, options?.until),
      update: (signal, transform, options) =>
        record(
          signal,
          (current) => transform(current as Immutable<typeof current>),
          options?.until,
        ),
    }),
  );

  const rollback = () => {
    batch(() => {
      for (const drop of drops) drop();
    });
  };

  action?.then(rollback, rollback);

  return { rollback };
}
