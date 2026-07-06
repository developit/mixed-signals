type CacheRef<T extends object> = WeakRef<T> | StrongCacheRef<T>;

class StrongCacheRef<T extends object> {
  constructor(private value: T) {}

  deref(): T {
    return this.value;
  }
}

export const weakRefsAvailable = typeof WeakRef !== 'undefined';

export function createCacheRef<T extends object>(value: T): CacheRef<T> {
  return weakRefsAvailable ? new WeakRef(value) : new StrongCacheRef(value);
}

export function isCacheRef<T extends object = object>(
  value: unknown,
): value is CacheRef<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'deref' in value &&
    typeof value.deref === 'function'
  );
}

export type {CacheRef};
