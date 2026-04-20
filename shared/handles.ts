import type {Signal} from '@preact/signals-core';
import type {HandleKind} from './brand.ts';
import type {Shape} from './shapes.ts';

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
 *   - Shape cache that is *per-peer* (per-client on the server). Shapes are
 *     never released during a connection's lifetime — they're trivially small
 *     and cache benefits compound.
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

export class Handles {
  private entries = new Map<string, HandleEntry>();
  private byValue = new WeakMap<object, string>();
  private counters: Record<HandleKind, number> = {s: 0, o: 0, f: 0, p: 0};

  // Per-client caches. Decoupled from entries so disconnect cleanup is O(caches).
  private shapesByClient = new Map<ClientId, Map<number, true>>();
  private modelNamesByClient = new Map<ClientId, Map<number, true>>();
  /** Tracks whether a client has already received the full payload for a handle. */
  private sentHandlesByClient = new Map<ClientId, Set<string>>();

  // Shape / model-name registry shared across clients.
  private shapeIdByCtor = new WeakMap<object, number>();
  private shapeIdBySig = new Map<string, number>();
  private shapes = new Map<number, Shape>();
  private nextShapeId = 1;

  private modelNameIdByCtor = new WeakMap<object, number>();
  private modelNames = new Map<number, string>();
  private nextModelNameId = 1;

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
    this.shapesByClient.delete(clientId);
    this.modelNamesByClient.delete(clientId);
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

  // ───── shape cache ────────────────────────────────────────────────────────

  /**
   * Look up (or allocate) a shape id.
   *
   * The signature is always authoritative. The ctor cache is a micro-opt
   * for Models where every instance shares a shape — but plain objects all
   * have `Object` as their ctor yet may have wildly different shapes, so we
   * only use the ctor cache when the ctor is not `Object`.
   */
  shapeIdFor(
    ctor: object | undefined,
    signature: string,
    shape: Shape,
  ): number {
    const useCtorCache = ctor && ctor !== Object;
    if (useCtorCache) {
      const hit = this.shapeIdByCtor.get(ctor);
      if (hit !== undefined) return hit;
    }
    let id = this.shapeIdBySig.get(signature);
    if (id === undefined) {
      id = this.nextShapeId++;
      this.shapeIdBySig.set(signature, id);
      this.shapes.set(id, shape);
    }
    if (useCtorCache) this.shapeIdByCtor.set(ctor, id);
    return id;
  }

  getShape(id: number): Shape | undefined {
    return this.shapes.get(id);
  }

  /** Has the given client already seen this shape inline? */
  hasShape(clientId: ClientId, shapeId: number): boolean {
    return this.shapesByClient.get(clientId)?.has(shapeId) ?? false;
  }

  markShapeSent(clientId: ClientId, shapeId: number) {
    let m = this.shapesByClient.get(clientId);
    if (!m) {
      m = new Map();
      this.shapesByClient.set(clientId, m);
    }
    m.set(shapeId, true);
  }

  // ───── model-name cache ───────────────────────────────────────────────────

  /** Allocate (or reuse) a model-name id for a ctor. */
  modelNameIdFor(ctor: object, name: string): number {
    let id = this.modelNameIdByCtor.get(ctor);
    if (id === undefined) {
      id = this.nextModelNameId++;
      this.modelNameIdByCtor.set(ctor, id);
      this.modelNames.set(id, name);
    }
    return id;
  }

  getModelName(id: number): string | undefined {
    return this.modelNames.get(id);
  }

  /** Has the given client already seen this model name inline? */
  hasModelName(clientId: ClientId, nameId: number): boolean {
    return this.modelNamesByClient.get(clientId)?.has(nameId) ?? false;
  }

  markModelNameSent(clientId: ClientId, nameId: number) {
    let m = this.modelNamesByClient.get(clientId);
    if (!m) {
      m = new Map();
      this.modelNamesByClient.set(clientId, m);
    }
    m.set(nameId, true);
  }
}

// Helper types re-exported from the type boundary so consumers don't need to
// import from @preact/signals-core directly.
export type {Signal};
