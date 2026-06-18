import {computed, type ReadonlySignal, signal} from '@preact/signals-core';

/** Pure overlay transform applied over the current value. Must not mutate it. */
export type OptimisticApply<T> = (current: T) => T;

/**
 * True once the server-owned source has absorbed a patch, so it can be dropped.
 * `confirmed` is set when the bound action resolves (or `confirm()` is called).
 *
 * Note: each patch is evaluated independently against the bare server value, so
 * a settled predicate cannot express "cancel an earlier patch". To return the
 * overlay to the source value, `rollback()` the earlier operation (the shape
 * builders below do this automatically when a later change targets the same key).
 */
export type OptimisticSettled<T> = (server: T, confirmed: boolean) => boolean;

/** A single optimistic change layered over a source value. */
export interface OptimisticPatch<T> {
  apply: OptimisticApply<T>;
  settled: OptimisticSettled<T>;
}

/** Handle to a live optimistic patch. */
export interface OptimisticOperation {
  /** Drop this patch, typically after the action fails. Idempotent. */
  rollback(): void;
  /**
   * Mark the change as accepted so it reconciles once the source reflects it.
   * Called automatically when a bound action resolves. Idempotent.
   */
  confirm(): void;
}

/** A derived, read-only overlay of a source signal plus pending patches. */
export interface Optimistic<T> {
  /** Source value folded through every still-pending patch, in insertion order. */
  readonly value: ReadonlySignal<T>;
  /**
   * Layer a patch over the source. While no patch is pending, a patch the source
   * already reflects is a no-op; once patches are live the new patch is always
   * layered (it may be needed to override them). A bound `action` confirms the
   * patch on resolve and rolls it back on reject.
   */
  patch(patch: OptimisticPatch<T>, action?: Promise<unknown>): OptimisticOperation;
  /** Drop every pending patch. */
  clear(): void;
  /** Drop every pending patch and stop observing the source. */
  dispose(): void;
}

interface Entry<T> {
  readonly id: number;
  readonly patch: OptimisticPatch<T>;
  readonly confirmed: boolean;
}

const inert: OptimisticOperation = {rollback() {}, confirm() {}};

/** Create an optimistic overlay over any reflected (read-only) signal. */
export function createOptimistic<T>(source: ReadonlySignal<T>): Optimistic<T> {
  const entries = signal<readonly Entry<T>[]>([]);
  let nextId = 1;
  let disposed = false;
  let stop: (() => void) | undefined;
  let starting = false;

  const stopPruning = () => {
    stop?.();
    stop = undefined;
  };

  const startPruning = () => {
    if (stop !== undefined || starting || entries.peek().length === 0) return;

    starting = true;
    const dispose = source.subscribe(prune);
    starting = false;
    stop = dispose;

    // Subscribing fires `prune` synchronously, which may have emptied entries.
    if (entries.peek().length === 0) stopPruning();
  };

  const setEntries = (next: readonly Entry<T>[]) => {
    entries.value = next;
    // Read live entries: a reentrant write may have repopulated them.
    if (entries.peek().length === 0) stopPruning();
    else startPruning();
  };

  const survivors = (current: readonly Entry<T>[], server: T) =>
    current.filter((entry) => !entry.patch.settled(server, entry.confirmed));

  const prune = (server: T) => {
    const current = entries.peek();
    if (current.length === 0) return;

    const live = survivors(current, server);
    if (live.length !== current.length) setEntries(live);
  };

  const removeEntry = (id: number) => {
    const current = entries.peek();
    const next = current.filter((entry) => entry.id !== id);
    if (next.length !== current.length) setEntries(next);
  };

  const confirmEntry = (id: number) => {
    const current = entries.peek();
    let changed = false;
    const confirmed = current.map((entry) => {
      if (entry.id !== id || entry.confirmed) return entry;
      changed = true;
      return {...entry, confirmed: true};
    });
    if (!changed) return;
    // Confirming may settle the patch against a value the source already holds.
    setEntries(survivors(confirmed, source.peek()));
  };

  const value = computed(() => {
    const server = source.value;
    const live = survivors(entries.value, server);
    if (live.length === 0) return server;
    return live.reduce((current, entry) => entry.patch.apply(current), server);
  });

  return {
    value,
    patch(patch, action) {
      // Short-circuit only when nothing is pending: once patches are live a new
      // one may be required to override them, so it must still be layered even if
      // the bare source already satisfies it. (Survivors prunes it later if it is
      // genuinely redundant.)
      if (
        disposed ||
        (entries.peek().length === 0 && patch.settled(source.peek(), false))
      ) {
        action?.catch(() => {});
        return inert;
      }

      const entry: Entry<T> = {id: nextId++, patch, confirmed: false};
      setEntries([...entries.peek(), entry]);

      action?.then(
        () => confirmEntry(entry.id),
        () => removeEntry(entry.id),
      );

      return {
        rollback() {
          removeEntry(entry.id);
        },
        confirm() {
          confirmEntry(entry.id);
        },
      };
    },
    clear() {
      setEntries([]);
    },
    dispose() {
      disposed = true;
      setEntries([]);
    },
  };
}

/** Stable application key used to reconcile optimistic items with server items. */
export type OptimisticKey = string | number;

export interface OptimisticListOptions<T, K extends OptimisticKey> {
  /** Return a stable key the server echoes on the confirmed item. */
  key(item: T): K;
  /** Match a server item that confirms an optimistic item under a different key. */
  match?(serverItem: T, optimisticItem: T): boolean;
}

export interface OptimisticList<T> {
  /** Source list plus all currently unconfirmed optimistic items. */
  readonly value: ReadonlySignal<readonly T[]>;
  /** Optimistic items present in the overlay but not yet in the source. */
  readonly pending: ReadonlySignal<readonly T[]>;
  /**
   * Append an item; reconciled only when the source contains a matching item
   * (by `key` or `match`). The bound action's resolution does not settle an
   * insert — if the server never echoes the key, supply `match` or the item
   * lingers alongside the server copy.
   */
  insert(item: T, action?: Promise<unknown>): OptimisticOperation;
  /**
   * Hide an item; reconciled when the source no longer contains it. Also cancels
   * any still-pending optimistic `insert`/`edit` for the same key.
   */
  remove(item: T, action?: Promise<unknown>): OptimisticOperation;
  /** Override fields of a matching item; reconciled when the source reflects them. */
  edit(item: T, changes: Partial<T>, action?: Promise<unknown>): OptimisticOperation;
  clear(): void;
  dispose(): void;
}

function changesApplied<T>(item: T, changes: Partial<T>): boolean {
  for (const field in changes) {
    if (!Object.prototype.hasOwnProperty.call(changes, field)) continue;
    if (!Object.is(item[field], changes[field])) return false;
  }
  return true;
}

/** True if the server moved any edited field off the value it held when edited. */
function editedFieldsMoved<T>(base: T, current: T, changes: Partial<T>): boolean {
  for (const field in changes) {
    if (!Object.prototype.hasOwnProperty.call(changes, field)) continue;
    if (!Object.is(base[field], current[field])) return true;
  }
  return false;
}

/** Create an optimistic overlay for a reflected list signal. */
export function optimisticList<T, K extends OptimisticKey>(
  source: ReadonlySignal<readonly T[]>,
  options: OptimisticListOptions<T, K>,
): OptimisticList<T> {
  const core = createOptimistic(source);
  const same = (a: T, b: T) =>
    options.key(a) === options.key(b) || options.match?.(a, b) === true;

  // Live optimistic operations per key, so `remove` can cancel a pending
  // `insert`/`edit` of an item that exists only in the overlay.
  const live = new Map<K, Set<OptimisticOperation>>();
  const track = (item: T, op: OptimisticOperation): OptimisticOperation => {
    if (op === inert) return op;
    const k = options.key(item);
    let set = live.get(k);
    if (set === undefined) live.set(k, (set = new Set()));
    set.add(op);
    return op;
  };

  const pending = computed(() => {
    const server = source.value;
    return core.value.value.filter((item) => !server.some((s) => same(s, item)));
  });

  return {
    value: core.value,
    pending,
    insert(item, action) {
      return track(
        item,
        core.patch(
          {
            apply: (list) => [...list, item],
            settled: (server) => server.some((s) => same(s, item)),
          },
          action,
        ),
      );
    },
    remove(item, action) {
      // Cancel any pending optimistic changes to this key first: removing an
      // item that exists only in the overlay should make it vanish, not stack a
      // filter patch beneath the insert.
      const k = options.key(item);
      const prior = live.get(k);
      if (prior !== undefined) {
        for (const op of prior) op.rollback();
        live.delete(k);
      }
      return core.patch(
        {
          apply: (list) => list.filter((s) => !same(s, item)),
          settled: (server) => !server.some((s) => same(s, item)),
        },
        action,
      );
    },
    edit(item, changes, action) {
      const base = source.peek().find((s) => same(s, item));
      return track(
        item,
        core.patch(
          {
            apply: (list) =>
              list.map((s) => (same(s, item) ? {...s, ...changes} : s)),
            settled: (server, confirmed) => {
              const current = server.find((s) => same(s, item));
              // A missing item settles the edit only if it was there when edited,
              // so editing an item that exists only optimistically still applies.
              if (current === undefined) return base !== undefined;
              // Otherwise the edit settles once the server reflects the requested
              // fields, or — after confirmation — once it moves those exact fields
              // off the value they held when edited (covers normalized writes
              // whose fields are not reference-equal). An unrelated delta that
              // leaves the edited fields untouched does not settle it.
              return (
                changesApplied(current, changes) ||
                (confirmed &&
                  (base === undefined ||
                    editedFieldsMoved(base, current, changes)))
              );
            },
          },
          action,
        ),
      );
    },
    clear() {
      live.clear();
      core.clear();
    },
    dispose() {
      live.clear();
      core.dispose();
    },
  };
}

export interface OptimisticObjectOptions<T extends object> {
  /**
   * Reconcile a property when the server value equals the optimistic value.
   * Defaults to `Object.is`. Use it when the server normalizes a write (e.g.
   * trimming) so the reflected value is equal-but-not-identical.
   */
  equals?<K extends keyof T>(server: T[K], optimistic: T[K], key: K): boolean;
}

export interface OptimisticObject<T extends object> {
  /** Source object plus all currently unconfirmed optimistic property changes. */
  readonly value: ReadonlySignal<T>;
  /** Set a property; reconciled when the source reflects the value. */
  set<K extends keyof T>(
    key: K,
    value: T[K],
    action?: Promise<unknown>,
  ): OptimisticOperation;
  /** Delete a property; reconciled when the source drops the key. */
  delete<K extends keyof T>(key: K, action?: Promise<unknown>): OptimisticOperation;
  clear(): void;
  dispose(): void;
}

/** Create an optimistic overlay for a reflected object signal. */
export function optimisticObject<T extends object>(
  source: ReadonlySignal<T>,
  options?: OptimisticObjectOptions<T>,
): OptimisticObject<T> {
  const core = createOptimistic(source);
  const matches = <K extends keyof T>(server: T[K], optimistic: T[K], key: K) =>
    options?.equals?.(server, optimistic, key) ?? Object.is(server, optimistic);

  // The latest pending operation per key. A new change to a key supersedes the
  // previous one so setting a value back to the source cancels cleanly.
  const ops = new Map<keyof T, OptimisticOperation>();
  const supersede = <K extends keyof T>(
    key: K,
    op: OptimisticOperation,
  ): OptimisticOperation => {
    ops.set(key, op);
    return op;
  };

  return {
    value: core.value,
    set(key, value, action) {
      ops.get(key)?.rollback();
      return supersede(
        key,
        core.patch(
          {
            apply: (object) => ({...object, [key]: value}),
            settled: (server) => matches(server[key], value, key),
          },
          action,
        ),
      );
    },
    delete(key, action) {
      ops.get(key)?.rollback();
      const present = key in source.peek();
      return supersede(
        key,
        core.patch(
          {
            apply: (object) => {
              const next = {...object};
              delete next[key];
              return next;
            },
            // When the key was not in the source (deleting an optimistic set),
            // wait for confirmation rather than settling on its mere absence.
            settled: (server, confirmed) =>
              !(key in server) && (present || confirmed),
          },
          action,
        ),
      );
    },
    clear() {
      ops.clear();
      core.clear();
    },
    dispose() {
      ops.clear();
      core.dispose();
    },
  };
}

export interface OptimisticValueOptions<T> {
  /** Reconcile when the server value matches the optimistic value. Defaults to `Object.is`. */
  equals?(server: T, optimistic: T): boolean;
}

export interface OptimisticValue<T> {
  /** Source value, or the pending optimistic value while one is set. */
  readonly value: ReadonlySignal<T>;
  /** Replace the value; reconciled when the source matches it. */
  set(next: T, action?: Promise<unknown>): OptimisticOperation;
  clear(): void;
  dispose(): void;
}

/** Create an optimistic overlay for a reflected value signal. */
export function optimisticValue<T>(
  source: ReadonlySignal<T>,
  options?: OptimisticValueOptions<T>,
): OptimisticValue<T> {
  const core = createOptimistic(source);
  const equals = options?.equals;
  const matches = (server: T, optimistic: T) =>
    equals ? equals(server, optimistic) : Object.is(server, optimistic);

  // Only the latest set is meaningful, so a new set supersedes the previous one.
  let pending: OptimisticOperation | undefined;

  return {
    value: core.value,
    set(next, action) {
      pending?.rollback();
      return (pending = core.patch(
        {
          apply: () => next,
          settled: (server) => matches(server, next),
        },
        action,
      ));
    },
    clear() {
      pending = undefined;
      core.clear();
    },
    dispose() {
      pending = undefined;
      core.dispose();
    },
  };
}
