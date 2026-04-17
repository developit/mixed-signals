import type {Signal} from '@preact/signals-core';
import type {Handles} from '../shared/handles.ts';
import {
  formatNotificationMessage,
  PROMISE_REJECT_METHOD,
  PROMISE_RESOLVE_METHOD,
  SIGNAL_UPDATE_METHOD,
} from '../shared/protocol.ts';
import {type SerializeHooks, Serializer} from '../shared/serialize.ts';

type SignalId = string;
type ClientId = string;
type DeltaMode = 'append' | 'merge';

interface RpcSender {
  send(clientId: string, message: string): void;
}

/**
 * Server-side reactivity + delta pusher. Owns:
 *   - signal subscription lifecycle (lazy: only subscribes to a source Signal
 *     once at least one client is watching)
 *   - per-client "last sent value" cache for diffing
 *   - pushes `@S` signal update notifications with delta mode when possible
 *
 * Unlike the previous incarnation it no longer tracks model constructors or
 * instance ids — those live in `Handles` and the shared serializer.
 */
export class Reflection {
  private signals = new Map<SignalId, Signal<any>>();
  private subscriptions = new Map<SignalId, Set<ClientId>>();
  private signalUnsubscribe = new Map<SignalId, () => void>();
  private lastSentValues = new Map<string, any>();
  private rpc: RpcSender;
  private serializer: Serializer;

  constructor(rpc: RpcSender, handles: Handles) {
    this.rpc = rpc;
    this.serializer = new Serializer(handles);
  }

  /**
   * Serialize a value for a specific client. Wires any newly-emitted signals
   * into the subscription table (lazy-subscription happens on first watch)
   * and attaches settlement listeners to any pending promises.
   */
  serialize(value: any, clientId: ClientId): any {
    const hooks: SerializeHooks = {
      peerId: clientId,
      onSignalEmitted: (id, sig) => {
        this.signals.set(id, sig);
        // Seed lastSentValues with the current peek so the first diff against
        // a subsequent update is stable.
        this.lastSentValues.set(`${clientId}:${id}`, sig.peek());
      },
      onPromiseEmitted: (id, p) => {
        // Settlement is delivered as a notification so it can carry a nested
        // serialized value (which may itself be a model or signal).
        p.then(
          (v) => {
            const payload = this.serialize(v, clientId);
            this.rpc.send(
              clientId,
              formatNotificationMessage(PROMISE_RESOLVE_METHOD, [id, payload]),
            );
          },
          (err) => {
            const msg = err?.message ?? String(err);
            this.rpc.send(
              clientId,
              formatNotificationMessage(PROMISE_REJECT_METHOD, [
                id,
                {message: msg},
              ]),
            );
          },
        );
      },
    };
    const out = this.serializer.serialize(value, hooks);
    if (out === undefined) return null;
    return JSON.parse(JSON.stringify(out));
  }

  // ───── watch / unwatch ─────────────────────────────────────────────────────

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
      if (sig && !this.signalUnsubscribe.has(signalId)) {
        const unsub = sig.subscribe(() => this.notifySubscribers(signalId));
        this.signalUnsubscribe.set(signalId, unsub);
      }
    }
  }

  unwatch(clientId: ClientId, signalId: SignalId) {
    const subs = this.subscriptions.get(signalId);
    if (!subs) return;
    subs.delete(clientId);
    if (subs.size === 0) {
      this.subscriptions.delete(signalId);
      const unsub = this.signalUnsubscribe.get(signalId);
      if (unsub) {
        unsub();
        this.signalUnsubscribe.delete(signalId);
      }
    }
  }

  removeClient(clientId: ClientId) {
    for (const [id, subs] of this.subscriptions) {
      if (subs.delete(clientId) && subs.size === 0) {
        this.subscriptions.delete(id);
        const unsub = this.signalUnsubscribe.get(id);
        if (unsub) {
          unsub();
          this.signalUnsubscribe.delete(id);
        }
      }
    }
    const prefix = `${clientId}:`;
    for (const key of this.lastSentValues.keys()) {
      if (key.startsWith(prefix)) this.lastSentValues.delete(key);
    }
  }

  /** Purge local state for a specific signal id (called on handle release). */
  forgetSignal(signalId: SignalId) {
    this.subscriptions.delete(signalId);
    const unsub = this.signalUnsubscribe.get(signalId);
    if (unsub) {
      unsub();
      this.signalUnsubscribe.delete(signalId);
    }
    this.signals.delete(signalId);
    const prefix = `:${signalId}`;
    for (const key of this.lastSentValues.keys()) {
      if (key.endsWith(prefix)) this.lastSentValues.delete(key);
    }
  }

  // ───── push ────────────────────────────────────────────────────────────────

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
