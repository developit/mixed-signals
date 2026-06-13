import {
  computed,
  type ReadonlySignal,
  signal,
} from '@preact/signals-core';

export type OptimisticListKey = string | number;

export interface OptimisticListOptions<T, TKey extends OptimisticListKey> {
  /** Return a stable application key used to reconcile optimistic items. */
  key(item: T): TKey;
  /** Optionally match server-confirmed items that use a different key. */
  match?(serverItem: T, optimisticItem: T): boolean;
}

export interface OptimisticListOperation<
  T,
  TKey extends OptimisticListKey,
> {
  readonly id: number;
  readonly key: TKey;
  readonly item: T;
  /** Remove this optimistic item, typically after the server rejects a call. */
  rollback(): void;
}

export interface OptimisticList<T, TKey extends OptimisticListKey> {
  /** Server source list plus all currently unconfirmed optimistic items. */
  readonly value: ReadonlySignal<readonly T[]>;
  /** Optimistic items that have not been confirmed by the server source. */
  readonly pending: ReadonlySignal<readonly T[]>;
  /** Add an optimistic item without mutating the reflected source signal. */
  insert(item: T): OptimisticListOperation<T, TKey>;
  /** Remove a previously inserted optimistic operation. */
  remove(operation: OptimisticListOperation<T, TKey>): void;
  /** Remove all pending optimistic operations. */
  clear(): void;
  /** Stop reconciliation effects and remove all pending optimistic operations. */
  dispose(): void;
}

interface PendingOptimisticListItem<T, TKey extends OptimisticListKey> {
  readonly id: number;
  readonly key: TKey;
  readonly item: T;
}

interface OptimisticListOperationIdentity {
  readonly id: number;
  readonly key: OptimisticListKey;
  rollback(): void;
}

const optimisticListOwnerBrand = Symbol('OptimisticListOwner');

interface OptimisticListOwner {
  readonly [optimisticListOwnerBrand]: true;
}

const operationOwners = new WeakMap<
  OptimisticListOperationIdentity,
  OptimisticListOwner
>();

function matchesServerItem<T, TKey extends OptimisticListKey>(
  serverItem: T,
  pendingItem: PendingOptimisticListItem<T, TKey>,
  options: OptimisticListOptions<T, TKey>,
): boolean {
  if (options.key(serverItem) === pendingItem.key) return true;
  return options.match?.(serverItem, pendingItem.item) === true;
}

function isConfirmed<T, TKey extends OptimisticListKey>(
  serverItems: readonly T[],
  pendingItem: PendingOptimisticListItem<T, TKey>,
  options: OptimisticListOptions<T, TKey>,
): boolean {
  return serverItems.some((serverItem) =>
    matchesServerItem(serverItem, pendingItem, options),
  );
}

function getUnconfirmedEntries<T, TKey extends OptimisticListKey>(
  serverItems: readonly T[],
  entries: readonly PendingOptimisticListItem<T, TKey>[],
  options: OptimisticListOptions<T, TKey>,
): PendingOptimisticListItem<T, TKey>[] {
  return entries.filter((entry) => !isConfirmed(serverItems, entry, options));
}

/**
 * Create a client-side optimistic overlay for a reflected list signal.
 * The source signal is never mutated; server-confirmed items are reconciled by key.
 * While optimistic items are pending, the source is subscribed so confirmations
 * can be pruned even if the overlay is not currently observed.
 */
export function createOptimisticList<T, TKey extends OptimisticListKey>(
  source: ReadonlySignal<readonly T[]>,
  options: OptimisticListOptions<T, TKey>,
): OptimisticList<T, TKey> {
  const entries = signal<readonly PendingOptimisticListItem<T, TKey>[]>([]);
  const owner: OptimisticListOwner = {[optimisticListOwnerBrand]: true};
  let nextId = 1;
  let stopSourcePrune: (() => void) | undefined;
  let startingSourcePrune = false;

  const stopPruning = () => {
    stopSourcePrune?.();
    stopSourcePrune = undefined;
  };

  const setEntries = (
    nextEntries: readonly PendingOptimisticListItem<T, TKey>[],
  ) => {
    entries.value = nextEntries;
    if (entries.peek().length === 0) {
      stopPruning();
    } else {
      startPruning();
    }
  };

  const pruneEntries = (sourceItems: readonly T[]) => {
    const current = entries.peek();
    if (current.length === 0) return;

    const unconfirmed = getUnconfirmedEntries(sourceItems, current, options);
    if (unconfirmed.length !== current.length) {
      setEntries(unconfirmed);
    }
  };

  const startPruning = () => {
    if (
      stopSourcePrune !== undefined ||
      startingSourcePrune ||
      entries.peek().length === 0
    ) {
      return;
    }

    startingSourcePrune = true;
    const stop = source.subscribe(pruneEntries);
    startingSourcePrune = false;
    stopSourcePrune = stop;

    if (entries.peek().length === 0) stopPruning();
  };

  const pending = computed(
    () =>
      getUnconfirmedEntries(source.value, entries.value, options).map(
        (entry) => entry.item,
      ),
  );

  const value = computed(
    () => {
      const sourceItems = source.value;
      const unconfirmed = getUnconfirmedEntries(
        sourceItems,
        entries.value,
        options,
      );
      if (unconfirmed.length === 0) return sourceItems;
      return [...sourceItems, ...unconfirmed.map((entry) => entry.item)];
    },
  );

  const remove = (operation: OptimisticListOperation<T, TKey>) => {
    if (operationOwners.get(operation) !== owner) return;

    const current = entries.peek();
    const nextEntries = current.filter((entry) => entry.id !== operation.id);
    if (nextEntries.length !== current.length) setEntries(nextEntries);
  };

  const clear = () => {
    setEntries([]);
  };

  return {
    value,
    pending,
    insert(item) {
      const sourceItems = source.peek();
      const entry: PendingOptimisticListItem<T, TKey> = {
        id: nextId++,
        key: options.key(item),
        item,
      };
      const current = getUnconfirmedEntries(sourceItems, entries.peek(), options);
      setEntries(
        isConfirmed(sourceItems, entry, options) ? current : [...current, entry],
      );

      const operation: OptimisticListOperation<T, TKey> = {
        id: entry.id,
        key: entry.key,
        item: entry.item,
        rollback() {
          remove(operation);
        },
      };
      operationOwners.set(operation, owner);
      return operation;
    },
    remove,
    clear,
    dispose() {
      clear();
    },
  };
}
