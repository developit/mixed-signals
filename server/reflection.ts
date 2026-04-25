import {Signal} from '@preact/signals-core';
import {
  formatNotificationMessage,
  SIGNAL_UPDATE_METHOD,
} from '../shared/protocol.ts';
import type {Instances} from './instances.ts';

type SignalId = number;
type ClientId = string;
type DeltaMode = 'append' | 'merge';

interface RpcSender {
  send(clientId: string, message: string): void;
}

type ModelConstructor =
  | (new (
      ...args: any[]
    ) => any)
  | ((...args: any[]) => any);

export class Reflection {
  private signalIds = new WeakMap<Signal<any>, SignalId>();
  private signals = new Map<SignalId, Signal<any>>();
  private subscriptions = new Map<SignalId, Set<ClientId>>();
  private lastSentValues = new Map<string, any>();
  private sentModels = new Map<ClientId, Set<string>>();
  private nextSignalId = 1;
  private rpc: RpcSender;
  private instances: Instances;
  private modelRegistry = new Map<ModelConstructor, string>();
  private modelNameCache = new WeakMap<object, string | null>();
  private autoIds = new WeakMap<object, string>();

  constructor(rpc: RpcSender, instances: Instances) {
    this.rpc = rpc;
    this.instances = instances;
  }

  registerModel(name: string, Ctor: ModelConstructor) {
    this.modelRegistry.set(Ctor, name);
  }

  isModel(val: any): boolean {
    if (typeof val !== 'object' || val === null) return false;
    return this.getModelType(val) !== undefined;
  }

  getModelType(val: any): string | undefined {
    if (typeof val !== 'object' || val === null) return undefined;

    const cached = this.modelNameCache.get(val);
    if (cached !== undefined) {
      return cached === null ? undefined : cached;
    }

    for (const [Ctor, name] of this.modelRegistry) {
      if (val instanceof Ctor) {
        this.modelNameCache.set(val, name);
        return name;
      }
    }

    this.modelNameCache.set(val, null);
  }

  getInstanceId(instance: any): string {
    const existingId = this.instances.getId(instance);
    if (existingId !== undefined) return existingId;

    if ('id' in instance) {
      const id = instance.id;
      return String(id instanceof Signal ? id.peek() : id);
    }

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

  private serializeValue(value: any, clientId?: ClientId): any {
    if (value === this.rpc || value === this || value === this.instances)
      return undefined;
    if (typeof value === 'function') return undefined;

    if (value instanceof Signal) {
      const id = this.getSignalId(value);
      const signalValue = value.peek();

      if (clientId) {
        this.lastSentValues.set(`${clientId}:${id}`, signalValue);
        this.watch(clientId, id);
      }

      return {'@S': id, v: this.serializeValue(signalValue, clientId)};
    }

    if (this.isModel(value)) {
      const typeName = this.getModelType(value)!;
      const instanceId = this.getInstanceId(value);
      const marker = `${typeName}#${instanceId}`;

      if (!this.instances.get(instanceId)) {
        this.instances.register(instanceId, value);
      }

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

      const branded: Record<string, any> = {'@M': marker};
      for (const [key, prop] of Object.entries(value)) {
        if (key.startsWith('_')) continue;

        const serializedProp = this.serializeValue(prop, clientId);
        if (serializedProp !== undefined) {
          branded[key] = serializedProp;
        }
      }

      return branded;
    }

    if (Array.isArray(value)) {
      return value.map((item) => {
        const serializedItem = this.serializeValue(item, clientId);
        return serializedItem === undefined ? null : serializedItem;
      });
    }

    if (value && typeof value === 'object') {
      const serialized: Record<string, any> = {};
      for (const [key, prop] of Object.entries(value)) {
        if (key.startsWith('_')) continue;

        const serializedProp = this.serializeValue(prop, clientId);
        if (serializedProp !== undefined) {
          serialized[key] = serializedProp;
        }
      }

      return serialized;
    }

    return value;
  }

  serialize(value: any, clientId?: ClientId): any {
    const serialized = this.serializeValue(value, clientId);
    if (serialized === undefined) return null;
    return serialized;
  }

  watch(clientId: ClientId, signalId: SignalId) {
    let subs = this.subscriptions.get(signalId);
    if (!subs) {
      subs = new Set();
      this.subscriptions.set(signalId, subs);
    }

    const isFirst = subs.size === 0;
    subs.add(clientId);

    if (isFirst) {
      const sig = this.signals.get(signalId);
      if (sig) {
        // The server only subscribes to source signals once a client cares.
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
      if (!update) continue;

      const serializedValue = this.serialize(update.value, clientId);
      const params = update.mode
        ? [signalId, serializedValue, update.mode]
        : [signalId, serializedValue];

      this.rpc.send(
        clientId,
        formatNotificationMessage(SIGNAL_UPDATE_METHOD, params),
      );
      this.lastSentValues.set(`${clientId}:${signalId}`, newValue);
    }
  }

  /**
   * Compute the delta between the last-sent value and the new value.
   * Returns null if the values are shallow-equal (no update needed).
   */
  private computeDelta(
    oldValue: any,
    newValue: any,
  ): {value: any; mode?: DeltaMode} | null {
    if (oldValue === undefined) return {value: newValue};

    if (Array.isArray(oldValue) && Array.isArray(newValue)) {
      if (
        newValue.length > oldValue.length &&
        oldValue.every((value, index) => value === newValue[index])
      ) {
        return {value: newValue.slice(oldValue.length), mode: 'append'};
      }
      // Same length, same elements — no update needed.
      if (
        newValue.length === oldValue.length &&
        oldValue.every((value, index) => value === newValue[index])
      ) {
        return null;
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

      // No changed keys and no removed keys — no update needed.
      if (!hasChanges) {
        const oldKeys = Object.keys(oldValue);
        const newKeys = Object.keys(newValue);
        if (oldKeys.length === newKeys.length) return null;
      }

      if (hasChanges) return {value: changes, mode: 'merge'};
    }

    if (
      typeof oldValue === 'string' &&
      typeof newValue === 'string' &&
      newValue.startsWith(oldValue)
    ) {
      if (newValue.length === oldValue.length) return null;
      return {value: newValue.slice(oldValue.length), mode: 'append'};
    }

    return {value: newValue};
  }
}
