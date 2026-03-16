import {Signal} from '@preact/signals-core';
import type {Instances} from './instances';

type SignalId = number;
type ClientId = string;

export class Reflection {
  private signalIds = new WeakMap<Signal<any>, SignalId>();
  private signals = new Map<SignalId, Signal<any>>();
  private subscriptions = new Map<SignalId, Set<ClientId>>();
  private lastSentValues = new Map<string, any>();
  private sentModels = new Map<ClientId, Set<string>>();
  private nextSignalId = 1;
  private rpc: any;
  private instances: Instances;
  private modelRegistry = new Map<new (...args: any[]) => any, string>();
  private autoIds = new WeakMap<object, string>();

  constructor(rpc: any, instances: Instances) {
    this.rpc = rpc;
    this.instances = instances;
  }

  registerModel(name: string, Ctor: new (...args: any[]) => any) {
    this.modelRegistry.set(Ctor, name);
  }

  isModel(val: any): boolean {
    if (typeof val !== 'object' || val === null) return false;
    for (const Ctor of this.modelRegistry.keys()) {
      if (val instanceof Ctor) return true;
    }
    return false;
  }

  getModelType(val: any): string | undefined {
    for (const [Ctor, name] of this.modelRegistry) {
      if (val instanceof Ctor) return name;
    }
  }

  getInstanceId(instance: any): string {
    // Already registered? (covers root at "0")
    const existingId = this.instances.getId(instance);
    if (existingId !== undefined) return existingId;

    // Model with id property — unwrap Signal, coerce to string
    if ('id' in instance) {
      const id = instance.id;
      return String(id instanceof Signal ? id.peek() : id);
    }

    // Auto-generate
    let id = this.autoIds.get(instance);
    if (id === undefined) {
      id = this.instances.nextId();
      this.autoIds.set(instance, id);
    }
    return id;
  }

  private getSignalId(sig: Signal<any>): SignalId {
    let id = this.signalIds.get(sig);
    if (!id) {
      id = this.nextSignalId++;
      this.signalIds.set(sig, id);
      this.signals.set(id, sig);
    }
    return id;
  }

  serialize(value: any, clientId?: ClientId): any {
    const json = JSON.stringify(value, (key, val) => {
      if (key.startsWith('_') && key !== '@S' && key !== '@M') return undefined;

      // Skip signal-wire internals if they appear during serialization
      if (val === this.rpc || val === this || val === this.instances)
        return undefined;

      // Signal → signal marker
      if (val instanceof Signal) {
        const id = this.getSignalId(val);
        const signalValue = val.peek();
        if (clientId) {
          this.lastSentValues.set(`${clientId}:${id}`, signalValue);
        }
        return {'@S': id, v: signalValue};
      }

      // Model instance → brand with type#id, skip functions
      if (this.isModel(val)) {
        const typeName = this.getModelType(val)!;
        const instanceId = this.getInstanceId(val);
        const marker = `${typeName}#${instanceId}`;

        // Auto-register in instances
        if (!this.instances.get(instanceId)) {
          this.instances.register(instanceId, val);
        }

        // If already sent to this client, emit just the ref
        if (clientId) {
          let sent = this.sentModels.get(clientId);
          if (sent?.has(marker)) {
            return {'@M': marker};
          }
          if (!sent) {
            sent = new Set();
            this.sentModels.set(clientId, sent);
          }
          sent.add(marker);
        }

        const branded: any = {'@M': marker};
        for (const k in val) {
          if (k.startsWith('_')) continue;
          const prop = val[k];
          if (typeof prop === 'function') continue;
          if (prop instanceof Signal) {
            const id = this.getSignalId(prop);
            const signalValue = prop.peek();
            if (clientId) {
              this.lastSentValues.set(`${clientId}:${id}`, signalValue);
            }
            branded[k] = {'@S': id, v: signalValue};
          } else {
            branded[k] = prop;
          }
        }
        return branded;
      }

      return val;
    });
    return json !== undefined ? JSON.parse(json) : null;
  }

  watch(clientId: ClientId, signalId: SignalId) {
    if (!this.subscriptions.has(signalId)) {
      this.subscriptions.set(signalId, new Set());
    }
    const subs = this.subscriptions.get(signalId)!;
    const isFirst = subs.size === 0;
    subs.add(clientId);

    if (isFirst) {
      const sig = this.signals.get(signalId);
      if (sig) {
        sig.subscribe(() => {
          this.notifySubscribers(signalId);
        });
      }
    }
  }

  unwatch(clientId: ClientId, signalId: SignalId) {
    this.subscriptions.get(signalId)?.delete(clientId);
  }

  removeClient(clientId: ClientId) {
    for (const subs of this.subscriptions.values()) {
      subs.delete(clientId);
    }
    const prefix = `${clientId}:`;
    for (const key of this.lastSentValues.keys()) {
      if (key.startsWith(prefix)) this.lastSentValues.delete(key);
    }
    this.sentModels.delete(clientId);
  }

  private notifySubscribers(signalId: SignalId) {
    const sig = this.signals.get(signalId);
    const clients = this.subscriptions.get(signalId);
    if (!sig || !clients || clients.size === 0) return;

    const newValue = sig.peek();

    for (const clientId of clients) {
      const lastValue = this.lastSentValues.get(`${clientId}:${signalId}`);

      if (lastValue === newValue) continue;

      const update = this.computeDelta(lastValue, newValue);
      const serializedValue = this.serialize(update.value, clientId);

      const params = update.mode
        ? [signalId, serializedValue, update.mode]
        : [signalId, serializedValue];
      const paramStr = params.map((p) => JSON.stringify(p)).join(',');
      const msg = `N:@S:${paramStr}`;
      this.rpc.send(clientId, msg);

      this.lastSentValues.set(`${clientId}:${signalId}`, newValue);
    }
  }

  private computeDelta(
    oldValue: any,
    newValue: any,
  ): {value: any; mode?: string} {
    if (oldValue === undefined) return {value: newValue};

    if (Array.isArray(oldValue) && Array.isArray(newValue)) {
      if (
        newValue.length > oldValue.length &&
        newValue.slice(0, oldValue.length).every((v, i) => v === oldValue[i])
      ) {
        return {value: newValue.slice(oldValue.length), mode: 'append'};
      }
    }

    if (
      oldValue &&
      newValue &&
      typeof oldValue === 'object' &&
      typeof newValue === 'object' &&
      !Array.isArray(oldValue)
    ) {
      const changes: any = {};
      let hasChanges = false;
      for (const key in newValue) {
        if (newValue[key] !== oldValue[key]) {
          changes[key] = newValue[key];
          hasChanges = true;
        }
      }
      if (hasChanges) return {value: changes, mode: 'merge'};
    }

    if (
      typeof oldValue === 'string' &&
      typeof newValue === 'string' &&
      newValue.startsWith(oldValue)
    ) {
      return {value: newValue.slice(oldValue.length), mode: 'append'};
    }

    return {value: newValue};
  }
}
