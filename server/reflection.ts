import {Signal} from '@preact/signals-core';
import {
  formatNotificationMessage,
  SIGNAL_UPDATE_METHOD,
} from '../shared/protocol.ts';
import type {Instances} from './instances.ts';

type SignalId = number;
type ClientId = string;
type DeltaMode = 'append' | 'merge';

const FINAL_NOTIFICATION_DELAY = 1_000;

interface RpcSender {
  send(clientId: string, message: string): void;
}

type ModelConstructor =
  | (new (
      ...args: any[]
    ) => any)
  | ((...args: any[]) => any);

// Values whose keys never appear on the wire: serializeValue drops undefined
// and functions, and the JSON round trip in serialize() drops symbols.
function isWireDropped(value: any): boolean {
  return (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  );
}

export class Reflection {
  private signalIds = new WeakMap<Signal<any>, SignalId>();
  private signalModels = new WeakMap<Signal<any>, Set<object>>();
  private signals = new Map<SignalId, Signal<any>>();
  private subscriptions = new Map<SignalId, Set<ClientId>>();
  private signalUnsubscribers = new Map<SignalId, () => void>();
  private lastSentValues = new Map<string, any>();
  private finalSignals = new WeakSet<Signal<any>>();
  private pendingFinalSignals = new Map<ClientId, Set<SignalId>>();
  private finalNotificationTimer: ReturnType<typeof setTimeout> | undefined;
  private sentModels = new Map<ClientId, Set<string>>();
  private nextSignalId = 1;
  private rpc: RpcSender;
  private instances: Instances;
  private modelRegistry = new Map<ModelConstructor, string>();
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
    const existingId = this.instances.getId(instance);
    if (existingId !== undefined) return existingId;

    if ('id' in instance) {
      const id = instance.id;
      const resolved = String(id instanceof Signal ? id.peek() : id);
      // Wire ids are embedded in call frames ("M1:<id>#method:...") and model
      // markers ("Type#<id>"), so these delimiters would corrupt parsing.
      if (resolved.includes('#') || resolved.includes(':')) {
        throw new Error(
          `Model id "${resolved}" must not contain "#" or ":" (reserved by the wire format)`,
        );
      }
      return resolved;
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

  private serializeValue(
    value: any,
    clientId?: ClientId,
    owners?: Set<object>,
  ): any {
    if (value === this.rpc || value === this || value === this.instances)
      return undefined;
    if (typeof value === 'function') return undefined;

    if (value instanceof Signal) {
      const id = this.getSignalId(value);
      const signalValue = value.peek();
      if (owners) {
        let models = this.signalModels.get(value);
        if (!models) this.signalModels.set(value, (models = new Set()));
        for (const owner of owners) models.add(owner);
      }

      if (this.finalSignals.has(value)) {
        // Always inlined: an unwatched signal is only weakly held client-side,
        // so a bare ref could fail to resolve.
        return {
          '@S': id,
          v: this.serializeValue(signalValue, clientId, owners),
          f: 1,
        };
      }

      if (clientId) {
        const key = `${clientId}:${id}`;
        // Full models need field values. Standalone signals can use a bare reference
        // only while this client stays subscribed and holds the current value.
        const alreadyHeld =
          !owners &&
          this.lastSentValues.has(key) &&
          this.lastSentValues.get(key) === signalValue &&
          !!this.subscriptions.get(id)?.has(clientId);
        this.lastSentValues.set(key, signalValue);
        this.watch(clientId, id);
        if (alreadyHeld) return {'@S': id};
      }

      return {'@S': id, v: this.serializeValue(signalValue, clientId, owners)};
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
      const modelOwners = new Set([value]);
      for (const [key, prop] of Object.entries(value)) {
        if (key.startsWith('_')) continue;

        const serializedProp = this.serializeValue(prop, clientId, modelOwners);
        if (serializedProp !== undefined) {
          branded[key] = serializedProp;
        }
      }

      return branded;
    }

    if (Array.isArray(value)) {
      return value.map((item) => {
        const serializedItem = this.serializeValue(item, clientId, owners);
        return serializedItem === undefined ? null : serializedItem;
      });
    }

    if (value && typeof value === 'object') {
      const serialized: Record<string, any> = {};
      for (const [key, prop] of Object.entries(value)) {
        if (key.startsWith('_')) continue;

        const serializedProp = this.serializeValue(prop, clientId, owners);
        if (serializedProp !== undefined) {
          serialized[key] = serializedProp;
        }
      }

      return serialized;
    }

    return value;
  }

  serialize(value: any, clientId?: ClientId, owners?: Set<object>): any {
    const serialized = this.serializeValue(value, clientId, owners);
    if (serialized === undefined) return null;

    return JSON.parse(JSON.stringify(serialized));
  }

  serializeModelMarker(marker: string, clientId?: ClientId): any {
    const hashIdx = marker.lastIndexOf('#');
    if (hashIdx === -1) return null;

    const typeName = marker.slice(0, hashIdx);
    const id = marker.slice(hashIdx + 1);
    const instance = this.instances.get(id);
    if (!instance || this.getModelType(instance) !== typeName) return null;

    if (clientId) {
      this.sentModels.get(clientId)?.delete(marker);
    }

    return this.serialize(instance, clientId);
  }

  markFinal(signals: Iterable<Signal<any>>) {
    for (const sig of signals) {
      if (this.finalSignals.has(sig)) continue;
      this.finalSignals.add(sig);

      const id = this.signalIds.get(sig);
      if (id === undefined) continue;
      const subs = this.subscriptions.get(id);
      if (!subs) continue;

      for (const clientId of subs) {
        let ids = this.pendingFinalSignals.get(clientId);
        if (!ids) this.pendingFinalSignals.set(clientId, (ids = new Set()));
        ids.add(id);
      }
      this.subscriptions.delete(id);
      this.signalUnsubscribers.get(id)?.();
      this.signalUnsubscribers.delete(id);
    }

    if (this.pendingFinalSignals.size > 0 && !this.finalNotificationTimer) {
      this.finalNotificationTimer = setTimeout(
        () => this.flushFinalNotifications(),
        FINAL_NOTIFICATION_DELAY,
      );
    }
  }

  private flushFinalNotifications() {
    this.finalNotificationTimer = undefined;
    const pending = this.pendingFinalSignals;
    this.pendingFinalSignals = new Map();

    for (const [clientId, ids] of pending) {
      for (const id of ids) {
        this.rpc.send(
          clientId,
          formatNotificationMessage(SIGNAL_UPDATE_METHOD, [id, null, 'seal']),
        );
      }
    }
  }

  watch(clientId: ClientId, signalId: SignalId) {
    const sig = this.signals.get(signalId);
    if (sig && this.finalSignals.has(sig)) return;

    let subs = this.subscriptions.get(signalId);
    if (!subs) {
      subs = new Set();
      this.subscriptions.set(signalId, subs);
    }

    subs.add(clientId);
    if (!sig) return;

    if (!this.signalUnsubscribers.has(signalId)) {
      // The server only subscribes to source signals once a client cares.
      // Subscribing notifies immediately, which doubles as catch-up for
      // this first watcher.
      const unsubscribe = sig.subscribe(() => {
        this.notifySubscribers(signalId);
      });
      this.signalUnsubscribers.set(signalId, unsubscribe);
    } else {
      // A live subscription only forwards future changes. A client joining it
      // may have missed updates while unwatched, so send its current value.
      this.sendUpdateIfChanged(clientId, signalId, sig.peek());
    }
  }

  unwatch(clientId: ClientId, signalId: SignalId) {
    this.subscriptions.get(signalId)?.delete(clientId);
    this.lastSentValues.delete(`${clientId}:${signalId}`);
    const sig = this.signals.get(signalId);
    if (sig) {
      const visited = new Set<object>();
      this.forgetClientModels(sig.peek(), clientId, visited);
      for (const model of this.signalModels.get(sig) ?? []) {
        this.forgetClientModels(model, clientId, visited);
      }
    }
    this.disposeSignalIfUnwatched(signalId);
  }

  private forgetClientModels(
    value: any,
    clientId: ClientId,
    visited: Set<object>,
  ) {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    if (value === this.rpc || value === this || value === this.instances)
      return;
    visited.add(value);

    if (value instanceof Signal) {
      this.forgetClientModels(value.peek(), clientId, visited);
      return;
    }

    if (this.isModel(value)) {
      const marker = `${this.getModelType(value)}#${this.getInstanceId(value)}`;
      this.sentModels.get(clientId)?.delete(marker);
    }

    for (const [key, prop] of Object.entries(value)) {
      if (!key.startsWith('_'))
        this.forgetClientModels(prop, clientId, visited);
    }
  }

  removeClient(clientId: ClientId) {
    for (const [signalId, subs] of this.subscriptions) {
      subs.delete(clientId);
      this.disposeSignalIfUnwatched(signalId);
    }

    const prefix = `${clientId}:`;
    for (const key of this.lastSentValues.keys()) {
      if (key.startsWith(prefix)) this.lastSentValues.delete(key);
    }

    this.sentModels.delete(clientId);
    this.pendingFinalSignals.delete(clientId);
  }

  private disposeSignalIfUnwatched(signalId: SignalId) {
    const subs = this.subscriptions.get(signalId);
    if (subs && subs.size > 0) return;

    this.subscriptions.delete(signalId);
    this.signalUnsubscribers.get(signalId)?.();
    this.signalUnsubscribers.delete(signalId);
  }

  private notifySubscribers(signalId: SignalId) {
    const sig = this.signals.get(signalId);
    const clients = this.subscriptions.get(signalId);
    if (!sig || !clients || clients.size === 0) return;

    const newValue = sig.peek();

    for (const clientId of clients) {
      this.sendUpdateIfChanged(clientId, signalId, newValue);
    }
  }

  private sendUpdateIfChanged(
    clientId: ClientId,
    signalId: SignalId,
    newValue: any,
  ) {
    const key = `${clientId}:${signalId}`;
    const lastValue = this.lastSentValues.get(key);
    if (this.lastSentValues.has(key) && lastValue === newValue) return;

    const update = this.computeDelta(lastValue, newValue);
    if (!update) return;

    const signal = this.signals.get(signalId);
    const owners = signal && this.signalModels.get(signal);
    const serializedValue = this.serialize(update.value, clientId, owners);
    const params = update.mode
      ? [signalId, serializedValue, update.mode]
      : [signalId, serializedValue];

    this.rpc.send(
      clientId,
      formatNotificationMessage(SIGNAL_UPDATE_METHOD, params),
    );
    this.lastSentValues.set(`${clientId}:${signalId}`, newValue);
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
        return {
          value: newValue.slice(oldValue.length),
          mode: 'append',
        };
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
      !Array.isArray(oldValue) &&
      !Array.isArray(newValue)
    ) {
      // Merge deltas can only add or overwrite keys, so a key that leaves
      // the wire — removed outright, or set to a value serialization drops —
      // requires a full replacement.
      for (const key of Object.keys(oldValue)) {
        if (isWireDropped(oldValue[key])) continue;
        if (!Object.hasOwn(newValue, key) || isWireDropped(newValue[key])) {
          return {value: newValue};
        }
      }

      const changes: any = {};
      let hasChanges = false;

      for (const key of Object.keys(newValue)) {
        if (newValue[key] !== oldValue[key]) {
          changes[key] = newValue[key];
          hasChanges = true;
        }
      }

      // Removals were ruled out above, so no changed keys means no update.
      return hasChanges ? {value: changes, mode: 'merge'} : null;
    }

    if (
      typeof oldValue === 'string' &&
      typeof newValue === 'string' &&
      newValue.startsWith(oldValue)
    ) {
      if (newValue.length === oldValue.length) return null;
      return {
        value: newValue.slice(oldValue.length),
        mode: 'append',
      };
    }

    return {value: newValue};
  }
}
