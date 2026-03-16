export class Instances {
  private registry = new Map<string, any>();
  private reverseRegistry = new WeakMap<object, string>();
  private nextIdCounter = 1;

  nextId(): string {
    while (this.registry.has(String(this.nextIdCounter))) {
      this.nextIdCounter++;
    }
    return String(this.nextIdCounter++);
  }

  register(id: string, instance: any) {
    this.registry.set(id, instance);
    if (typeof instance === 'object' && instance !== null) {
      this.reverseRegistry.set(instance, id);
    }
  }

  get(id: string): any {
    return this.registry.get(id);
  }

  getId(instance: any): string | undefined {
    if (typeof instance !== 'object' || instance === null) return undefined;
    return this.reverseRegistry.get(instance);
  }

  remove(id: string) {
    const instance = this.registry.get(id);
    if (instance && typeof instance === 'object') {
      this.reverseRegistry.delete(instance);
    }
    this.registry.delete(id);
  }
}
