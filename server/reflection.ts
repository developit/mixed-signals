import type {Signal} from '@preact/signals-core';
import type {Handles} from '../shared/handles.ts';
import {
  PROMISE_REJECT_METHOD,
  PROMISE_RESOLVE_METHOD,
  SIGNAL_UPDATE_METHOD,
  type TransportContext,
} from '../shared/protocol.ts';
import {type SerializeHooks, Serializer} from '../shared/serialize.ts';

type SignalId = string;
type ClientId = string;
type DeltaMode = 'append' | 'merge';

interface RpcSender {
  sendNotification(
    clientId: string,
    method: string,
    params: unknown[],
    ctx?: TransportContext,
  ): void;
  /**
   * Per-client outbound codec hook, pulled off the client's transport so
   * user-registered type transforms (Map/Set/u8/custom) run during the
   * serializer's walk.
   */
  getEncode(
    clientId: string,
  ): ((value: unknown, ctx?: TransportContext) => unknown) | undefined;
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
  /**
   * Per-client set of promise ids we've already attached a settlement
   * listener for. Every `onPromiseEmitted` call checks this set so the
   * .then/.catch chain is registered exactly once per (client, promise)
   * pair — a promise shared across multiple clients settles for all of
   * them, but we only wire the listener once per destination.
   */
  private promiseListenersByClient = new Map<ClientId, Set<string>>();
  private rpc: RpcSender;
  private serializer: Serializer;
  private handles: Handles;

  constructor(rpc: RpcSender, handles: Handles) {
    this.rpc = rpc;
    this.handles = handles;
    this.serializer = new Serializer(handles);
  }

  /**
   * Serialize a value for a specific client. Wires any newly-emitted signals
   * into the subscription table (lazy-subscription happens on first watch)
   * and attaches settlement listeners to any pending promises.
   *
   * When `ctx` is provided, transferable values encountered during the walk
   * are collected into `ctx.transfer` so the raw-mode transport can forward
   * them as ownership transfers.
   */
  serialize(value: any, clientId: ClientId, ctx?: TransportContext): any {
    const hooks: SerializeHooks = {
      peerId: clientId,
      ctx,
      encode: this.rpc.getEncode(clientId),
      onSignalEmitted: (id, sig) => {
        this.signals.set(id, sig);
        // Seed lastSentValues with the current peek so the first diff against
        // a subsequent update is stable.
        this.lastSentValues.set(`${clientId}:${id}`, sig.peek());
      },
      onPromiseEmitted: (id, p) => {
        // Deliver the settlement to THIS client. Multiple clients may
        // receive the same promise id; each needs their own listener
        // so every peer sees the resolution. Dedup per client so we
        // don't double-send if the same promise is re-emitted in a
        // later frame.
        let seen = this.promiseListenersByClient.get(clientId);
        if (!seen) {
          seen = new Set();
          this.promiseListenersByClient.set(clientId, seen);
        }
        if (seen.has(id)) return;
        seen.add(id);
        // Settlement is delivered as a notification so it can carry a nested
        // serialized value (which may itself be a model or signal).
        p.then(
          (v) => {
            const settleCtx: TransportContext = {};
            const payload = this.serialize(v, clientId, settleCtx);
            this.rpc.sendNotification(
              clientId,
              PROMISE_RESOLVE_METHOD,
              [id, payload],
              settleCtx,
            );
          },
          (err) => {
            const msg = err?.message ?? String(err);
            this.rpc.sendNotification(clientId, PROMISE_REJECT_METHOD, [
              id,
              {message: msg},
            ]);
          },
        );
      },
    };
    const out = this.serializer.serialize(value, hooks);
    if (out === undefined) return null;
    return out;
  }

  // ───── watch / unwatch ─────────────────────────────────────────────────────

  watch(clientId: ClientId, signalId: SignalId) {
    // Authorisation: a client may only subscribe to a signal it has
    // previously received on the wire. Signal ids are sequential (`s1`,
    // `s2`, …) and enumerable, so without this check any client could
    // subscribe to the live update stream for every signal on the server
    // just by counting up.
    if (!this.handles.hasSentHandle(clientId, signalId)) return;
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
    this.promiseListenersByClient.delete(clientId);
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
      const ctx: TransportContext = {};
      const serializedValue = this.serialize(update.value, clientId, ctx);
      const params = update.mode
        ? [signalId, serializedValue, update.mode]
        : [signalId, serializedValue];
      this.rpc.sendNotification(clientId, SIGNAL_UPDATE_METHOD, params, ctx);
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
      // Use Object.keys (own-enumerable only); `for...in` walks the
      // prototype chain and would yield stray entries for any object
      // whose prototype carries enumerable props.
      const oldKeys = Object.keys(oldValue);
      const newKeys = Object.keys(newValue);
      const changes: any = {};
      let hasChanges = false;
      for (const key of newKeys) {
        if (newValue[key] !== oldValue[key]) {
          changes[key] = newValue[key];
          hasChanges = true;
        }
      }
      // Detect deleted keys: present in old, absent in new. The `merge`
      // mode cannot express a delete — a client applying `{...current,
      // ...delta}` would keep the stale key forever. So if any key was
      // removed, fall through to a full replace.
      let hasDeletions = false;
      if (newKeys.length < oldKeys.length) {
        for (const key of oldKeys) {
          if (!Object.hasOwn(newValue, key)) {
            hasDeletions = true;
            break;
          }
        }
      }
      if (hasDeletions) return {value: newValue};
      if (!hasChanges && oldKeys.length === newKeys.length) return null;
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
