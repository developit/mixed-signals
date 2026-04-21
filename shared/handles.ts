import type {Signal} from '@preact/signals-core';
import type {HandleKind} from './brand.ts';

/**
 * Single registry of everything that crosses the wire with identity. Used on
 * the server (today) and — once client-owned handles land — also on the client
 * to track values the *client* handed out.
 *
 * Design goals:
 *   - One id space keyed by a single-char kind prefix (s/o/f/p).
 *   - Fast id → value and value → id lookup.
 *   - Per-client refcounting so the same object passed to N clients is tracked
 *     independently. Once all clients release a handle and policy permits, the
 *     handle itself is dropped.
 *   - Class cache per connection: each (ctor or shape-signature) gets a stable
 *     numeric id, emitted inline the first time a peer sees it and by bare id
 *     afterwards.
 */

type ClientId = string;

export interface HandleEntry {
  id: string;
  kind: HandleKind;
  /** The live object / signal / function / promise. */
  value: any;
  /** When set, the registry uses a WeakRef and releases on GC. */
  weak?: boolean;
  /** Last-touched timestamp for TTL retention. */
  lastTouched: number;
  /** Clients that currently hold a reference, and their per-client refcount. */
  refs: Map<ClientId, number>;
}

/** Describes a cached class (ctor or plain-object shape). */
export interface ClassDef {
  id: number;
  /** Stamped name for a createModel-backed ctor, else null. */
  name: string | null;
  /** Ordered property names; position matches the positional `d` array. */
  keys: string[];
}

export class Handles {
  private entries = new Map<string, HandleEntry>();
  private byValue = new WeakMap<object, string>();
  private counters: Record<HandleKind, number> = {s: 0, o: 0, f: 0, p: 0};

  // Per-client caches. Decoupled from entries so disconnect cleanup is O(caches).
  private classesByClient = new Map<ClientId, Set<number>>();
  /** Tracks whether a client has already received the full payload for a handle. */
  private sentHandlesByClient = new Map<ClientId, Set<string>>();

  // Class registry shared across clients.
  private classIdByCtor = new WeakMap<object, number>();
  private classIdBySig = new Map<string, number>();
  private classDefs = new Map<number, ClassDef>();
  private nextClassId = 1;

  /** Allocate a new id with the given kind. */
  allocateId(kind: HandleKind): string {
    return `${kind}${++this.counters[kind]}`;
  }

  /** Register a value (not bumping refcount yet — that happens per client on emit). */
  register(id: string, value: any): HandleEntry {
    const existing = this.entries.get(id);
    if (existing) return existing;
    const entry: HandleEntry = {
      id,
      kind: id[0] as HandleKind,
      value,
      lastTouched: Date.now(),
      refs: new Map(),
    };
    this.entries.set(id, entry);
    if (value && (typeof value === 'object' || typeof value === 'function')) {
      this.byValue.set(value as object, id);
    }
    return entry;
  }

  /** Register with a pre-assigned id (used for root id "o0"). */
  registerWithId(id: string, _kind: HandleKind, value: any): HandleEntry {
    return this.register(id, value);
  }

  /** Fetch entry by id. */
  get(id: string): HandleEntry | undefined {
    return this.entries.get(id);
  }

  /** Fetch id for a live value, if any. */
  idOf(value: unknown): string | undefined {
    if (value == null) return undefined;
    const t = typeof value;
    if (t !== 'object' && t !== 'function') return undefined;
    return this.byValue.get(value as object);
  }

  /** Get a value by id (convenience). */
  valueOf(id: string): any {
    return this.entries.get(id)?.value;
  }

  /** Mark a handle as touched (used by TTL). */
  touch(id: string) {
    const e = this.entries.get(id);
    if (e) e.lastTouched = Date.now();
  }

  /** Retain a handle on behalf of a client. */
  retain(id: string, clientId: ClientId) {
    const e = this.entries.get(id);
    if (!e) return;
    const prev = e.refs.get(clientId) ?? 0;
    e.refs.set(clientId, prev + 1);
    e.lastTouched = Date.now();
  }

  /**
   * Release a handle for a client. Returns true if the entry is now fully
   * orphaned (no refs from any client), which the caller may use to free it.
   */
  release(id: string, clientId: ClientId, count = 1): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    const prev = e.refs.get(clientId) ?? 0;
    const next = prev - count;
    if (next <= 0) {
      e.refs.delete(clientId);
    } else {
      e.refs.set(clientId, next);
    }
    return e.refs.size === 0;
  }

  /** Drop an entry. */
  drop(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    if (
      e.value &&
      (typeof e.value === 'object' || typeof e.value === 'function')
    ) {
      const existing = this.byValue.get(e.value);
      if (existing === id) this.byValue.delete(e.value);
    }
  }

  /** All current entry ids (for sweep / debugging). */
  *ids(): IterableIterator<string> {
    for (const id of this.entries.keys()) yield id;
  }

  /** All entries (for TTL sweep). */
  *allEntries(): IterableIterator<HandleEntry> {
    for (const e of this.entries.values()) yield e;
  }

  /**
   * Release everything a client was holding. Returns the ids that became
   * fully orphaned (so the caller can free them from any secondary state
   * — lastSentValues, subscriptions, etc).
   *
   * Covers two populations:
   *   - tier 2 (`o`, `f`): ref-counted; orphaned means "last holder gone."
   *   - tier 1 (`s`): not refcounted; orphaned means "no other client has
   *     ever received this signal." We use `sentHandlesByClient` as the
   *     liveness witness.
   */
  releaseAllForClient(clientId: ClientId): string[] {
    const orphaned: string[] = [];
    // Tier 2: decrement refs.
    for (const e of this.entries.values()) {
      if (e.refs.delete(clientId) && e.refs.size === 0) orphaned.push(e.id);
    }
    // Snapshot this client's sent set before we drop it.
    const sent = this.sentHandlesByClient.get(clientId);
    this.classesByClient.delete(clientId);
    this.sentHandlesByClient.delete(clientId);
    // Tier 1: signals the departing client saw, that no remaining client
    // has seen, are orphaned too.
    if (sent) {
      for (const id of sent) {
        if (id[0] !== 's') continue;
        let stillSeen = false;
        for (const otherSent of this.sentHandlesByClient.values()) {
          if (otherSent.has(id)) {
            stillSeen = true;
            break;
          }
        }
        if (!stillSeen) orphaned.push(id);
      }
    }
    return orphaned;
  }

  // ───── handle "have we sent the body yet?" cache ─────────────────────────

  hasSentHandle(clientId: ClientId, id: string): boolean {
    return this.sentHandlesByClient.get(clientId)?.has(id) ?? false;
  }

  markHandleSent(clientId: ClientId, id: string) {
    let s = this.sentHandlesByClient.get(clientId);
    if (!s) {
      s = new Set();
      this.sentHandlesByClient.set(clientId, s);
    }
    s.add(id);
  }

  clearHandleSent(clientId: ClientId, id: string) {
    this.sentHandlesByClient.get(clientId)?.delete(id);
  }

  // ───── class cache ────────────────────────────────────────────────────────

  /**
   * Look up (or allocate) a class id for a given ctor / signature / class def.
   *
   * Caching rules:
   *   - The ctor cache is a fast-path for stable-shape classes (Models:
   *     every instance carries the same factory output; normal classes
   *     whose instances always have the same own-property set). We only
   *     consult it when the ctor is not `Object` and only trust the hit
   *     if the current shape signature ALSO matches the cached def — a
   *     hand-written class with conditionally-present own properties can
   *     still serialize correctly, it just allocates a fresh class id
   *     when its shape differs.
   *   - The signature cache catches ctor-less / anonymous cases.
   */
  classIdFor(
    ctor: object | undefined,
    signature: string,
    name: string | null,
    keys: string[],
  ): number {
    const useCtorCache = ctor && ctor !== Object;
    if (useCtorCache) {
      const hit = this.classIdByCtor.get(ctor);
      if (hit !== undefined) {
        // Trust the ctor cache only when the shape matches. Otherwise fall
        // through to signature-based allocation: two instances with
        // different own-property sets deserve different class ids.
        const cachedDef = this.classDefs.get(hit);
        if (cachedDef && signaturesMatch(cachedDef.keys, keys)) return hit;
      }
    }
    let id = this.classIdBySig.get(signature);
    if (id === undefined) {
      id = this.nextClassId++;
      this.classIdBySig.set(signature, id);
      this.classDefs.set(id, {id, name, keys});
    }
    // Only update the ctor cache if it was empty; never overwrite a prior
    // mapping to a different id (keeps "first instance wins" semantics, so
    // the most common shape stays the fast-path hit).
    if (useCtorCache && this.classIdByCtor.get(ctor) === undefined) {
      this.classIdByCtor.set(ctor, id);
    }
    return id;
  }

  getClass(id: number): ClassDef | undefined {
    return this.classDefs.get(id);
  }

  /** Has the given client already seen this class inline? */
  hasClass(clientId: ClientId, classId: number): boolean {
    return this.classesByClient.get(clientId)?.has(classId) ?? false;
  }

  markClassSent(clientId: ClientId, classId: number) {
    let s = this.classesByClient.get(clientId);
    if (!s) {
      s = new Set();
      this.classesByClient.set(clientId, s);
    }
    s.add(classId);
  }
}

function signaturesMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Helper types re-exported from the type boundary so consumers don't need to
// import from @preact/signals-core directly.
export type {Signal};
