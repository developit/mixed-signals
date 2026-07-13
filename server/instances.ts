import {createCacheRef, isCacheRef, weakRefsAvailable} from './cache-ref.ts';

export class Instances {
  private registry = new Map<string, unknown>();
  private reverseRegistry = new WeakMap<object, string>();
  private finalizer?: FinalizationRegistry<string>;
  private nextIdCounter = 1;

  constructor() {
    if (weakRefsAvailable && typeof FinalizationRegistry !== 'undefined') {
      this.finalizer = new FinalizationRegistry((id) => {
        const ref = this.registry.get(id);
        if (isCacheRef(ref) && !ref.deref()) this.registry.delete(id);
      });
    }
  }

  nextId(): string {
    let id: string;
    do {
      id = String(this.nextIdCounter++);
    } while (this.get(id) !== undefined);
    return id;
  }

  register(id: string, instance: any) {
    const existing = this.get(id);
    if (existing === instance) return;
    if (typeof existing === 'object' && existing !== null) {
      this.reverseRegistry.delete(existing);
    }

    if (typeof instance === 'object' && instance !== null) {
      this.registry.set(id, createCacheRef(instance));
      this.reverseRegistry.set(instance, id);
      this.finalizer?.register(instance, id);
      return;
    }

    this.registry.set(id, instance);
  }

  get(id: string): any {
    const value = this.registry.get(id);
    if (isCacheRef(value)) {
      const instance = value.deref();
      if (!instance) this.registry.delete(id);
      return instance;
    }

    return value;
  }

  getId(instance: any): string | undefined {
    if (typeof instance !== 'object' || instance === null) return undefined;
    return this.reverseRegistry.get(instance);
  }

  remove(id: string) {
    const instance = this.get(id);
    if (instance && typeof instance === 'object') {
      this.reverseRegistry.delete(instance);
    }
    this.registry.delete(id);
  }
}
