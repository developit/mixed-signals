import {type Signal, signal} from '@preact/signals-core';
import {BRAND_REMOTE, type HandleKind, type RemoteBrand} from './brand.ts';
import {
  DATA_FIELD,
  HANDLE_MARKER,
  MODEL_NAME_FIELD,
  MODEL_NAME_ID_FIELD,
  SHAPE_FIELD,
  SHAPE_ID_FIELD,
  SIGNAL_VALUE_FIELD,
} from './protocol.ts';
import {type Shape, SLOT_SIGNAL, type SlotKind} from './shapes.ts';

/**
 * Minimal public surface the hydrator uses to do its job. The concrete RPC
 * client implements this. Kept abstract so hydration can later also run on
 * the server once client-owned handles land (separate follow-up commit).
 */
export interface HydrateEnv {
  /** Outgoing call (for method handles and function handles). */
  call(method: string, args: readonly unknown[]): Promise<any>;
  /**
   * Notify the owning peer we've released these handle ids. Batching is
   * handled inside the env implementation (debounced / coalesced).
   */
  scheduleRelease(id: string): void;
  /** Hook a Signal's watched/unwatched to the outbound @W/@U batches. */
  scheduleWatch(id: string): void;
  scheduleUnwatch(id: string): void;
  /**
   * Register a pending promise id → settlement functions. When the owning
   * peer later delivers R/E for this id, the client settles it.
   */
  registerPendingPromise(
    id: string,
    settle: {resolve(v: any): void; reject(e: any): void},
  ): void;
}

const HAS_FINALIZATION_REGISTRY = typeof FinalizationRegistry !== 'undefined';

export class Hydrator {
  private env: HydrateEnv;
  /** id → WeakRef<object> for reuse. */
  private handles = new Map<string, WeakRef<object> | object>();
  /** Shape cache (per connection). */
  private shapes = new Map<number, Shape>();
  /** Model-name cache (per connection). */
  private modelNames = new Map<number, string>();
  /** Registry that fires when a proxy becomes unreachable. */
  private finalization?: FinalizationRegistry<string>;

  constructor(env: HydrateEnv) {
    this.env = env;
    if (HAS_FINALIZATION_REGISTRY) {
      this.finalization = new FinalizationRegistry<string>((id) => {
        // Tier 2 only (o/f). Signals use @W/@U; promises settle once and are
        // never released by the client. Neither is ever registered here, so
        // the callback doesn't need to filter them out.
        const ref = this.handles.get(id);
        if (ref instanceof WeakRef && ref.deref() === undefined) {
          this.handles.delete(id);
          this.env.scheduleRelease(id);
        } else if (ref === undefined) {
          this.env.scheduleRelease(id);
        }
      });
    }
  }

  /** Reset everything (used on reconnect). */
  reset() {
    this.handles.clear();
    this.shapes.clear();
    this.modelNames.clear();
    // Old finalizers will fire eventually; they'll find nothing to release
    // and drop on the floor, which is safe.
  }

  /** The JSON.parse reviver. Pass this to `parseWireParams` / `parseWireValue`. */
  reviver = (_key: string, val: any): any => {
    if (val === null || typeof val !== 'object') return val;
    if (HANDLE_MARKER in val) return this.hydrate(val);
    return val;
  };

  // ───── entry point ────────────────────────────────────────────────────────

  hydrate(marker: any): any {
    const id: string = marker[HANDLE_MARKER];
    const kind = id[0] as HandleKind;

    // Fast path: we already have this handle.
    const existing = this.lookup(id);
    if (existing !== undefined) {
      // Short-ref case: marker only has @H. Use existing.
      if (!hasBody(marker)) return existing;
      // Full body on a known id — update the spine in place.
      this.updateExisting(existing, kind, marker);
      return existing;
    }

    // New handle. Install shape / model-name preludes first.
    if (SHAPE_FIELD in marker) {
      // Shape wire format: `{key: kind, …}`. ECMAScript guarantees
      // string-key insertion order round-trips through JSON.parse, so the
      // data array's iᵗʰ slot matches the iᵗʰ key here.
      const wireShape = marker[SHAPE_FIELD] as Record<string, SlotKind>;
      const keys: string[] = [];
      const kinds: SlotKind[] = [];
      for (const k in wireShape) {
        keys.push(k);
        kinds.push(wireShape[k]);
      }
      this.shapes.set(marker[SHAPE_ID_FIELD], {keys, kinds});
    }
    if (MODEL_NAME_FIELD in marker) {
      const [nameId, name] = marker[MODEL_NAME_FIELD] as [number, string];
      this.modelNames.set(nameId, name);
    }

    switch (kind) {
      case 's':
        return this.createSignal(id, marker[SIGNAL_VALUE_FIELD]);
      case 'o':
        return this.createObject(id, marker);
      case 'f':
        return this.createFunction(id);
      case 'p':
        return this.createPromise(id);
      default:
        throw new Error(`Unknown handle kind: ${kind} (${id})`);
    }
  }

  // ───── signal ─────────────────────────────────────────────────────────────

  private createSignal(id: string, initial: any): Signal<any> {
    let unwatchTimeout: ReturnType<typeof setTimeout> | null = null;
    const sig = signal(initial, {
      watched: () => {
        if (unwatchTimeout) {
          clearTimeout(unwatchTimeout);
          unwatchTimeout = null;
        } else {
          this.env.scheduleWatch(id);
        }
      },
      unwatched: () => {
        unwatchTimeout = setTimeout(() => {
          this.env.scheduleUnwatch(id);
          unwatchTimeout = null;
        }, 10);
      },
    });
    // Brand the signal so if it's passed back to the server the serializer
    // can round-trip it by id instead of cloning the value.
    Object.defineProperty(sig, BRAND_REMOTE, {
      value: {
        id,
        kind: 's',
        owner: 'server',
      } satisfies RemoteBrand,
      enumerable: false,
      configurable: true,
    });
    // Tier 1: signals are governed by @W/@U, not by GC. Store for lookup;
    // do not register with the FinalizationRegistry.
    this.handles.set(id, sig);
    return sig;
  }

  applySignalUpdate(id: string, value: any, mode?: string) {
    const sig = this.lookup(id) as Signal<any> | undefined;
    if (!sig) return;
    if (!mode) {
      sig.value = value;
      return;
    }
    const current = sig.value;
    switch (mode) {
      case 'append':
        if (Array.isArray(current)) sig.value = [...current, ...value];
        else if (typeof current === 'string') sig.value = current + value;
        break;
      case 'merge':
        if (current && typeof current === 'object')
          sig.value = {...current, ...value};
        break;
      case 'splice':
        if (Array.isArray(current)) {
          const {start, deleteCount, items} = value;
          const next = [...current];
          next.splice(start, deleteCount, ...items);
          sig.value = next;
        }
        break;
      default:
        sig.value = value;
    }
  }

  // ───── object / model ─────────────────────────────────────────────────────

  private createObject(id: string, marker: any): any {
    const shapeId: number = marker[SHAPE_ID_FIELD];
    const shape = this.shapes.get(shapeId);
    if (!shape) {
      throw new Error(
        `Missing shape ${shapeId} for handle ${id} (prelude was not sent).`,
      );
    }
    const nameId: number | undefined = marker[MODEL_NAME_ID_FIELD];
    const typeName =
      nameId !== undefined ? this.modelNames.get(nameId) : undefined;

    const data: any[] = marker[DATA_FIELD] ?? [];
    const spine: Record<string | symbol, any> = Object.create(null);
    for (let i = 0; i < shape.keys.length; i++) {
      spine[shape.keys[i]] = this.reviveSlot(shape.kinds[i], data[i]);
    }

    const brand: RemoteBrand = {id, kind: 'o', typeName, owner: 'server'};
    spine[BRAND_REMOTE] = brand;

    const methodCache = new Map<string, (...args: any[]) => any>();
    const env = this.env;
    let disposed = false;
    const disposeFn = () => {
      if (disposed) return;
      disposed = true;
      env.scheduleRelease(id);
    };
    const proxy = new Proxy(spine, {
      get(target, key) {
        if (key === BRAND_REMOTE) return target[BRAND_REMOTE];
        if (typeof key === 'symbol') {
          // Opt-in deterministic release via `using proxy = …` or a manual
          // `proxy[Symbol.dispose]()` call. Short-circuits GC.
          if (key === Symbol.dispose) return disposeFn;
          return (target as any)[key];
        }
        if (key in target) return target[key];
        // Well-known JS duck-typing probes: return undefined so runtime code
        // that checks `typeof obj.then === 'function'` (Promise resolution,
        // toString conversion, etc.) doesn't mistake this Proxy for a
        // thenable or a custom boxed primitive.
        if (
          key === 'then' ||
          key === 'catch' ||
          key === 'finally' ||
          key === 'toJSON' ||
          key === 'constructor'
        ) {
          return undefined;
        }
        // Unknown key — synthesize a method stub. Cached so function identity
        // is stable across multiple accesses.
        let m = methodCache.get(key);
        if (!m) {
          m = (...args: unknown[]) => env.call(`${id}#${key}`, args);
          methodCache.set(key, m);
        }
        return m;
      },
      has(target, key) {
        if (key === BRAND_REMOTE) return true;
        if (key in target) return true;
        // Hide duck-typing probes from `in` checks as well.
        if (
          key === 'then' ||
          key === 'catch' ||
          key === 'finally' ||
          key === 'toJSON'
        ) {
          return false;
        }
        // Pretend unknown string keys exist so `'someMethod' in proxy` returns
        // true — useful for duck-typing. Hidden from iteration.
        return typeof key === 'string';
      },
      ownKeys(target) {
        return Reflect.ownKeys(target).filter((k) => k !== BRAND_REMOTE);
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === BRAND_REMOTE) return undefined;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      set(target, key, value) {
        // Allow local writes (e.g. user caching something on the proxy) but
        // they never cross the wire. This matches how a client would patch
        // any other object locally.
        target[key] = value;
        return true;
      },
    });
    this.registerWithFinalization(id, proxy);
    return proxy;
  }

  private reviveSlot(_kind: SlotKind, data: any): any {
    if (data === null || data === undefined) return data;
    // If the JSON reviver already ran, this slot holds a real hydrated value
    // (Signal, Proxy, Promise, function). Those carry `BRAND_REMOTE`; skip.
    if (typeof data !== 'object') return data;
    if ((data as any)[BRAND_REMOTE]) return data;
    // Direct-path case (tests / in-process hydration without JSON.parse):
    // markers are plain objects with an own `@H` string.
    if (
      Object.hasOwn(data, HANDLE_MARKER) &&
      typeof (data as any)[HANDLE_MARKER] === 'string'
    ) {
      return this.hydrate(data);
    }
    return data;
  }

  private updateExisting(existing: any, kind: HandleKind, marker: any) {
    if (kind === 's') {
      const v = marker[SIGNAL_VALUE_FIELD];
      if (v !== undefined && existing.peek?.() !== v) {
        // Keep parity with old full-replace semantics. The subsequent @S
        // stream will carry any further changes.
        existing.value = v;
      }
      return;
    }
    if (kind === 'o') {
      const shapeId: number = marker[SHAPE_ID_FIELD];
      const shape = this.shapes.get(shapeId);
      if (!shape) return; // re-hydration without known shape is a no-op
      const data: any[] = marker[DATA_FIELD] ?? [];
      for (let i = 0; i < shape.keys.length; i++) {
        const key = shape.keys[i];
        const slotKind = shape.kinds[i];
        if (slotKind === SLOT_SIGNAL) {
          // Signal slots are already live on the spine. Only update them if
          // the server sent a new value (data[i] is {@H,v:...}).
          const inner = data[i];
          if (
            inner &&
            typeof inner === 'object' &&
            SIGNAL_VALUE_FIELD in inner
          ) {
            existing[key].value = inner[SIGNAL_VALUE_FIELD];
          }
        } else {
          existing[key] = this.reviveSlot(slotKind, data[i]);
        }
      }
    }
  }

  // ───── function ───────────────────────────────────────────────────────────

  private createFunction(id: string): (...args: any[]) => any {
    const env = this.env;
    const fn = (...args: unknown[]) => env.call(id, args);
    (fn as any)[BRAND_REMOTE] = {
      id,
      kind: 'f',
      owner: 'server',
    } satisfies RemoteBrand;
    this.registerWithFinalization(id, fn);
    return fn;
  }

  // ───── promise ────────────────────────────────────────────────────────────

  private createPromise(id: string): Promise<any> {
    let settle!: {resolve(v: any): void; reject(e: any): void};
    const p = new Promise<any>((resolve, reject) => {
      settle = {resolve, reject};
    });
    (p as any)[BRAND_REMOTE] = {
      id,
      kind: 'p',
      owner: 'server',
    } satisfies RemoteBrand;
    this.env.registerPendingPromise(id, settle);
    // Tier 3: one-shot lifecycle. No GC registration, no release frame. If
    // the client drops the Promise before the server settles, the settlement
    // arrives and finds no pending entry — fine.
    this.handles.set(id, p);
    return p;
  }

  // ───── registry / finalization ────────────────────────────────────────────

  /** Tier 2 registration: stored weakly, release sent on finalization. */
  private registerWithFinalization(id: string, value: object) {
    this.handles.set(id, new WeakRef(value));
    this.finalization?.register(value, id, value);
  }

  private lookup(id: string): any {
    const ref = this.handles.get(id);
    if (!ref) return undefined;
    if (ref instanceof WeakRef) {
      const v = ref.deref();
      if (v === undefined) {
        this.handles.delete(id);
        return undefined;
      }
      return v;
    }
    return ref;
  }

  /** For tests and introspection. */
  peek(id: string): any {
    return this.lookup(id);
  }
}

function hasBody(marker: any): boolean {
  // A marker "has a body" if it carries anything beyond @H.
  for (const k in marker) {
    if (k !== HANDLE_MARKER) return true;
  }
  return false;
}
