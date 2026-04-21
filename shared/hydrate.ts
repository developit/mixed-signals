import {type Signal, signal} from '@preact/signals-core';
import {BRAND_REMOTE, type HandleKind, type RemoteBrand} from './brand.ts';
import {
  CLASS_FIELD,
  DATA_FIELD,
  HANDLE_MARKER,
  PROPS_FIELD,
  SIGNAL_VALUE_FIELD,
} from './protocol.ts';

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

/**
 * Per-connection record of a cached class the hydrator has seen. `ctor` is
 * a synthetic function we mint for each class so that `instanceof` checks
 * work on the client: every instance we hydrate for this class is built as
 * `Object.create(ctor.prototype)`.
 */
export interface RemoteClass {
  id: number;
  name: string | null;
  keys: string[];
  ctor: new () => any;
}

const HAS_FINALIZATION_REGISTRY = typeof FinalizationRegistry !== 'undefined';

/**
 * Mint a named-at-runtime "class" function whose prototype is what we use
 * for remote instances. We don't want user code to construct these directly
 * (there's no local value to back it), so the ctor throws when called.
 */
function makeRemoteClass(name: string | null): new () => any {
  const display = name ?? 'RemoteObject';
  // Use a computed property on an object literal to pin the function name —
  // gives users a sensible `proxy.constructor.name` and `instanceof` target.
  const holder = {
    [display]: class {
      constructor() {
        throw new Error(
          `${display} is a remote class; construct values on the server.`,
        );
      }
    },
  } as Record<string, new () => any>;
  return holder[display];
}

export class Hydrator {
  private env: HydrateEnv;
  /** id → WeakRef<object> for reuse. */
  private handles = new Map<string, WeakRef<object> | object>();
  /** Class cache (per connection), keyed by numeric class id. */
  private classes = new Map<number, RemoteClass>();
  /** Secondary index for `classOf(name)` lookups. */
  private classesByName = new Map<string, RemoteClass>();
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
    this.classes.clear();
    this.classesByName.clear();
    // Old finalizers will fire eventually; they'll find nothing to release
    // and drop on the floor, which is safe.
  }

  /** The JSON.parse reviver. Pass this to `parseWireParams` / `parseWireValue`. */
  reviver = (_key: string, val: any): any => {
    if (val === null || typeof val !== 'object') return val;
    if (HANDLE_MARKER in val) return this.hydrate(val);
    return val;
  };

  /**
   * Resolve the remote class constructor by name. Returns `undefined` if the
   * client has never received an instance of a class with that name. Useful
   * for `instanceof` checks in user code.
   */
  classOf(name: string): (new () => any) | undefined {
    return this.classesByName.get(name)?.ctor;
  }

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

  // ───── object / class instance ────────────────────────────────────────────

  /**
   * Install a class def seen for the first time on the wire, or look one up.
   *
   *   - `c: "3#Counter"` or `c: "3"` → first emission; also carries a `p`
   *     field with the property list. Install the class def.
   *   - `c: 3` (numeric) → must already be known. If not, the server sent
   *     a bare class ref without the def — we throw a descriptive error
   *     so the condition is visible, not silently data-corrupting.
   */
  private ensureClass(cField: unknown, propsField: unknown): RemoteClass {
    let classId: number;
    let name: string | null = null;
    if (typeof cField === 'string') {
      const s = cField;
      const hashIdx = s.indexOf('#');
      const idPart = hashIdx === -1 ? s : s.slice(0, hashIdx);
      classId = Number.parseInt(idPart, 10);
      if (!Number.isFinite(classId)) {
        throw new Error(`Invalid class marker "${s}" — id is not numeric.`);
      }
      if (hashIdx !== -1) name = s.slice(hashIdx + 1);
    } else if (typeof cField === 'number' && Number.isFinite(cField)) {
      classId = cField;
    } else {
      throw new Error(
        `Invalid class marker of type ${typeof cField}; expected string or number.`,
      );
    }

    const existing = this.classes.get(classId);
    if (existing) return existing;

    // No entry yet — this must be a first emission, which requires `p`.
    if (typeof propsField !== 'string') {
      throw new Error(
        `Unknown class id ${classId} with no \`p\` prelude; server emitted a bare class reference before the class was introduced on this connection.`,
      );
    }
    const keys = propsField === '' ? [] : propsField.split(',');
    const cls: RemoteClass = {
      id: classId,
      name,
      keys,
      ctor: makeRemoteClass(name),
    };
    this.classes.set(classId, cls);
    if (name) this.classesByName.set(name, cls);
    return cls;
  }

  private createObject(id: string, marker: any): any {
    const hasClass = CLASS_FIELD in marker;
    let cls: RemoteClass | undefined;
    let typeName: string | undefined;

    let target: Record<string | symbol, any>;
    const dField = marker[DATA_FIELD];

    if (hasClass) {
      // Cached-class instance: positional `d` aligned to `cls.keys`.
      cls = this.ensureClass(marker[CLASS_FIELD], marker[PROPS_FIELD]);
      typeName = cls.name ?? undefined;
      target = Object.create(cls.ctor.prototype);
      const data: any[] = Array.isArray(dField) ? dField : [];
      for (let i = 0; i < cls.keys.length; i++) {
        target[cls.keys[i]] = this.reviveSlot(data[i]);
      }
    } else {
      // Ad-hoc object: keyed `d`. No class, no typeName, no `instanceof`.
      target = Object.create(null);
      if (dField && typeof dField === 'object') {
        for (const key in dField) {
          target[key] = this.reviveSlot(dField[key]);
        }
      }
    }

    const brand: RemoteBrand = {id, kind: 'o', typeName, owner: 'server'};
    target[BRAND_REMOTE] = brand;

    const methodCache = new Map<string, (...args: any[]) => any>();
    const env = this.env;

    let disposed = false;
    const disposeFn = () => {
      if (disposed) return;
      disposed = true;
      // Cancel the GC callback so it doesn't send a second @D once the
      // proxy is collected. Unregister before scheduleRelease so if the
      // release flushes synchronously we still reach the unregister.
      this.unregisterFinalization(id);
      env.scheduleRelease(id);
    };
    const proxy = new Proxy(target, {
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
        // Faithful membership: `key in proxy` answers "is this an own or
        // inherited property of the backing target?" and nothing more. This
        // matches `Reflect.has` / `Object.hasOwn` expectations. Duck-typing
        // via `'method' in proxy` doesn't work for trap-dispatched methods
        // — call `proxy.method?.()` instead.
        return key in target;
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

  private reviveSlot(data: any): any {
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
      const hasClass = CLASS_FIELD in marker;
      const dField = marker[DATA_FIELD];
      if (hasClass) {
        const cls = this.ensureClass(marker[CLASS_FIELD], marker[PROPS_FIELD]);
        const data: any[] = Array.isArray(dField) ? dField : [];
        for (let i = 0; i < cls.keys.length; i++) {
          const key = cls.keys[i];
          const slot = existing[key];
          const incoming = data[i];
          if (
            slot &&
            typeof slot === 'object' &&
            (slot as any)[BRAND_REMOTE]?.kind === 's' &&
            incoming &&
            typeof incoming === 'object' &&
            SIGNAL_VALUE_FIELD in incoming
          ) {
            (slot as Signal<any>).value = incoming[SIGNAL_VALUE_FIELD];
          } else {
            existing[key] = this.reviveSlot(incoming);
          }
        }
      } else if (dField && typeof dField === 'object') {
        for (const key in dField) {
          existing[key] = this.reviveSlot(dField[key]);
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

  /**
   * Tier 2 registration: stored weakly, release sent on finalization.
   *
   * The WeakRef we store in `handles` doubles as the unregister token so
   * `Symbol.dispose` can cancel the GC callback without holding a strong
   * reference to the proxy itself.
   */
  private registerWithFinalization(id: string, value: object) {
    const ref = new WeakRef(value);
    this.handles.set(id, ref);
    this.finalization?.register(value, id, ref);
  }

  private unregisterFinalization(id: string) {
    const ref = this.handles.get(id);
    if (ref instanceof WeakRef) this.finalization?.unregister(ref);
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
