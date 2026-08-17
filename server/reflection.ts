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
  private signals = new Map<SignalId, Signal<any>>();
  private subscriptions = new Map<SignalId, Set<ClientId>>();
  private signalUnsubscribers = new Map<SignalId, () => void>();
  private lastSentValues = new Map<string, any>();
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

  private serializeValue(value: any, clientId?: ClientId): any {
    if (value === this.rpc || value === this || value === this.instances)
      return undefined;
    if (typeof value === 'function') return undefined;

    if (value instanceof Signal) {
      const id = this.getSignalId(value);
      const signalValue = value.peek();

      if (clientId) {
        const key = `${clientId}:${id}`;
        // Send a bare ref when we can prove the client already holds this exact
        // value: its reviver resolves a `v`-less `{'@S':id}` against the signal
        // it has. Re-inlining would ship the payload twice, which for something
        // like a diff signal returned from an RPC is hundreds of KB of pure
        // duplicate. Same idea as the model dedup below.
        //
        // Both halves of the proof matter. The last-sent value says the bytes
        // got there; the live subscription says the client still has somewhere
        // to put them — a watched signal is strongly held client-side, so it
        // cannot have been collected out of the client's WeakRef cache. Check
        // it before watch() below adds the subscription. Reconnects are safe on
        // their own: removeClient() drops these entries when a client goes away
        // or resumes, so a fresh connection always gets values inlined.
        const alreadyHeld =
          this.lastSentValues.has(key) &&
          this.lastSentValues.get(key) === signalValue &&
          !!this.subscriptions.get(id)?.has(clientId);
        this.lastSentValues.set(key, signalValue);
        this.watch(clientId, id);
        if (alreadyHeld) return {'@S': id};
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

    return JSON.parse(JSON.stringify(serialized));
  }

  /**
   * Drop what we believe this client holds for a model's own signals, so the
   * next serialization inlines their values instead of sending bare refs. A
   * refresh means the client no longer trusts its copy — a ref pointing at that
   * copy is worthless. Nested models are refreshed under their own markers.
   */
  private forgetClientSignalValues(instance: any, clientId: ClientId) {
    for (const [key, prop] of Object.entries(instance)) {
      if (key.startsWith('_') || !(prop instanceof Signal)) continue;

      const id = this.signalIds.get(prop);
      if (id !== undefined) this.lastSentValues.delete(`${clientId}:${id}`);
    }
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
      this.forgetClientSignalValues(instance, clientId);
    }

    return this.serialize(instance, clientId);
  }

  watch(clientId: ClientId, signalId: SignalId) {
    let subs = this.subscriptions.get(signalId);
    if (!subs) {
      subs = new Set();
      this.subscriptions.set(signalId, subs);
    }

    subs.add(clientId);

    if (!this.signalUnsubscribers.has(signalId)) {
      const sig = this.signals.get(signalId);
      if (sig) {
        // The server only subscribes to source signals once a client cares.
        // Subscribing notifies immediately, which doubles as catch-up for
        // this first watcher.
        const unsubscribe = sig.subscribe(() => {
          this.notifySubscribers(signalId);
        });
        this.signalUnsubscribers.set(signalId, unsubscribe);
      }
    } else {
      // A live subscription only forwards future changes. A client joining it
      // may have missed updates while unwatched, so send a catch-up delta.
      const sig = this.signals.get(signalId);
      if (sig) {
        this.sendUpdateIfChanged(clientId, signalId, sig.peek());
      }
    }
  }

  unwatch(clientId: ClientId, signalId: SignalId) {
    this.subscriptions.get(signalId)?.delete(clientId);
    this.disposeSignalIfUnwatched(signalId);
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
    const lastValue = this.lastSentValues.get(`${clientId}:${signalId}`);
    if (lastValue === newValue) return;

    const update = this.computeDelta(lastValue, newValue);
    if (!update) return;

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
      return {value: newValue.slice(oldValue.length), mode: 'append'};
    }

    return {value: newValue};
  }
}
