import {Signal} from '@preact/signals-core';
import {BRAND_REMOTE, type RemoteBrand} from './brand.ts';
import type {Handles} from './handles.ts';
import {
  DATA_FIELD,
  HANDLE_MARKER,
  MODEL_NAME_FIELD,
  MODEL_NAME_ID_FIELD,
  SHAPE_FIELD,
  SHAPE_ID_FIELD,
  SIGNAL_VALUE_FIELD,
} from './protocol.ts';
import {type Shape, shapeSignature} from './shapes.ts';

/**
 * Brand stamped onto server-side Model constructors by our wrapped
 * `createModel(name, factory)`. Its presence on a constructor marks the
 * object as a "named" model — the serializer uses it to decide whether to
 * emit a model-name prelude.
 */
export const MODEL_NAME_SYMBOL: unique symbol = Symbol.for(
  'mixed-signals.modelName',
) as unknown as typeof MODEL_NAME_SYMBOL;

/** Hooks the caller passes in to drive the serializer. */
export interface SerializeHooks {
  /** The peer id we're serializing for — drives per-peer caches. */
  peerId: string;
  /** Called on every signal we emit, so the caller can wire subscriptions. */
  onSignalEmitted?(id: string, signal: Signal<any>): void;
  /** Called on every handle emission that requires client retention (o, f). */
  onHandleEmitted?(id: string): void;
  /**
   * Called once per Promise we give a pid to. Caller should attach settlement
   * listeners that send a later frame (@P / @PE) with the resolved value.
   */
  onPromiseEmitted?(id: string, promise: Promise<any>): void;
  /** Called on every function we emit. */
  onFunctionEmitted?(id: string, fn: (...args: any[]) => any): void;
}

/** Per-ctor cache for the behavior check (prototype walk is O(chain depth)). */
const hasMethodByCtor = new WeakMap<object, boolean>();

/**
 * A value is "behavioral" — and therefore earns an `o` handle — if its
 * constructor is stamped by `createModel` OR if any non-`_` member is a
 * function, anywhere in the prototype chain up to (but not including)
 * `Object.prototype`. This covers hand-written classes with methods while
 * correctly ignoring base `Object` methods like `hasOwnProperty`.
 */
function hasBehavior(obj: object): boolean {
  const ctor = obj.constructor as object | undefined;
  // Stamped Model ctors always upgrade.
  if (ctor && (ctor as any)[MODEL_NAME_SYMBOL] !== undefined) return true;

  // Own-prop fast path: a method declared directly on the instance counts.
  for (const key of Object.keys(obj)) {
    if (key[0] === '_') continue;
    if (typeof (obj as any)[key] === 'function') return true;
  }

  // No constructor / plain `{}` / `Object.create(null)` — nothing to walk.
  if (!ctor || ctor === Object) return false;

  // Prototype chain, cached by ctor.
  const cached = hasMethodByCtor.get(ctor);
  if (cached !== undefined) return cached;

  let result = false;
  let proto: object | null = (ctor as any).prototype ?? null;
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || key[0] === '_') continue;
      if (typeof (proto as any)[key] === 'function') {
        result = true;
        break;
      }
    }
    if (result) break;
    proto = Object.getPrototypeOf(proto);
  }
  hasMethodByCtor.set(ctor, result);
  return result;
}

/**
 * Build an object's wire shape. Enumerates own enumerable keys, skipping
 * `_`-prefixed and function-valued keys (methods live on the handle, not on
 * the data spine). Each remaining slot is tagged "signal" or "handle/plain",
 * which lets the hydrator install live Signals in the right spots.
 */
function shapeOfHandleObject(obj: Record<string, unknown>): Shape {
  const keys: string[] = [];
  const kinds: number[] = [];
  for (const key of Object.keys(obj)) {
    if (key[0] === '_') continue;
    const v = obj[key];
    if (typeof v === 'function') continue; // methods → trap-dispatched
    keys.push(key);
    // 1 = signal, 0 = everything else (handle or plain JSON, re-walked)
    kinds.push(v instanceof Signal ? 1 : 0);
  }
  return {keys, kinds: kinds as Shape['kinds']};
}

export class Serializer {
  private handles: Handles;
  /** Monotonic promise id counter — promises never touch Handles. */
  private nextPromiseId = 1;
  /** De-dupe pids for the same Promise instance across repeated emissions. */
  private promiseIds = new WeakMap<Promise<any>, string>();

  constructor(handles: Handles) {
    this.handles = handles;
  }

  /**
   * Serialize a value for a specific peer. Returns a JSON-serializable tree.
   * The output contains `@H` markers the receiving side hydrates.
   */
  serialize(value: any, hooks: SerializeHooks): any {
    return this.walk(value, hooks);
  }

  private walk(value: any, hooks: SerializeHooks): any {
    if (value === null || value === undefined) return value;
    const t = typeof value;

    if (t === 'string' || t === 'number' || t === 'boolean') return value;

    // A value that was previously hydrated from a wire frame — re-emit its id
    // so the owning peer can resolve it back to the original object/function.
    const brand = (value as any)[BRAND_REMOTE] as RemoteBrand | undefined;
    if (brand) {
      this.handles.touch(brand.id);
      return {[HANDLE_MARKER]: brand.id};
    }

    if (value instanceof Signal) return this.emitSignal(value, hooks);

    if (t === 'function')
      return this.emitFunction(value as (...a: any[]) => any, hooks);

    if (t !== 'object') return value;

    // Thenables get a pid; nothing else traverses through their state.
    if (typeof (value as any).then === 'function') {
      return this.emitPromise(value as Promise<any>, hooks);
    }

    if (Array.isArray(value)) {
      const out = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        const w = this.walk(value[i], hooks);
        out[i] = w === undefined ? null : w;
      }
      return out;
    }

    // Respect .toJSON — matches JSON.stringify's own behavior, lets Date and
    // user-defined types opt out of handle upgrading with a one-liner.
    const toJSON = (value as any).toJSON;
    if (typeof toJSON === 'function') {
      return this.walk(toJSON.call(value), hooks);
    }

    return this.emitObject(value as Record<string, unknown>, hooks);
  }

  // ───── signal (tier 1) ────────────────────────────────────────────────────

  private emitSignal(sig: Signal<any>, hooks: SerializeHooks): any {
    let id = this.handles.idOf(sig);
    if (!id || !this.handles.get(id)) {
      id = this.handles.allocateId('s');
      this.handles.register(id, sig);
    }
    hooks.onSignalEmitted?.(id, sig);
    // Subsequent emissions to the same client are bare references. Signals
    // never participate in refcounted release (their lifecycle is @W/@U).
    if (this.handles.hasSentHandle(hooks.peerId, id)) {
      return {[HANDLE_MARKER]: id};
    }
    this.handles.markHandleSent(hooks.peerId, id);
    // First emission: inline the current value so the receiver has a fully
    // hydrated signal on the first frame (matters for sync-RPC readers).
    const inner = this.walk(sig.peek(), hooks);
    return {[HANDLE_MARKER]: id, [SIGNAL_VALUE_FIELD]: inner};
  }

  // ───── function (tier 2) ──────────────────────────────────────────────────

  private emitFunction(
    fn: (...args: any[]) => any,
    hooks: SerializeHooks,
  ): any {
    let id = this.handles.idOf(fn);
    if (!id) {
      id = this.handles.allocateId('f');
      this.handles.register(id, fn);
    }
    hooks.onFunctionEmitted?.(id, fn);
    if (!this.handles.hasSentHandle(hooks.peerId, id)) {
      this.handles.retain(id, hooks.peerId);
      hooks.onHandleEmitted?.(id);
      this.handles.markHandleSent(hooks.peerId, id);
    }
    return {[HANDLE_MARKER]: id};
  }

  // ───── promise (tier 3, one-shot) ─────────────────────────────────────────

  private emitPromise(p: Promise<any>, hooks: SerializeHooks): any {
    // Promises are outside the Handles registry. Their lifecycle is a single
    // resolution or rejection; there is nothing to refcount or release.
    let id = this.promiseIds.get(p);
    if (!id) {
      id = `p${this.nextPromiseId++}`;
      this.promiseIds.set(p, id);
      hooks.onPromiseEmitted?.(id, p);
    }
    return {[HANDLE_MARKER]: id};
  }

  // ───── object (tier 2, may upgrade to `o` handle) ─────────────────────────

  private emitObject(obj: Record<string, unknown>, hooks: SerializeHooks): any {
    const known = this.handles.idOf(obj);
    const ctor = obj.constructor as object | undefined;
    const modelName =
      ctor && (ctor as any)[MODEL_NAME_SYMBOL] !== undefined
        ? ((ctor as any)[MODEL_NAME_SYMBOL] as string)
        : undefined;

    // Upgrade decision. Keep objects we've already allocated an id for
    // (some earlier call gave them identity) even if they'd otherwise look
    // plain now.
    const upgrade = !!known || hasBehavior(obj);

    if (!upgrade) {
      return this.emitPlainObject(obj, hooks);
    }

    const id = known ?? this.allocateObjectId(obj);

    // Short-reference path: client already has the body for this handle.
    if (this.handles.hasSentHandle(hooks.peerId, id)) {
      return {[HANDLE_MARKER]: id};
    }
    this.handles.retain(id, hooks.peerId);
    hooks.onHandleEmitted?.(id);
    this.handles.markHandleSent(hooks.peerId, id);

    const shape = shapeOfHandleObject(obj);
    const signature = shapeSignature(shape);
    const shapeId = this.handles.shapeIdFor(ctor, signature, shape);
    const sendShape = !this.handles.hasShape(hooks.peerId, shapeId);
    if (sendShape) this.handles.markShapeSent(hooks.peerId, shapeId);

    let sendModelName: number | undefined;
    let modelNameId: number | undefined;
    if (modelName && ctor) {
      modelNameId = this.handles.modelNameIdFor(ctor, modelName);
      if (!this.handles.hasModelName(hooks.peerId, modelNameId)) {
        sendModelName = modelNameId;
        this.handles.markModelNameSent(hooks.peerId, modelNameId);
      }
    }

    const data = this.emitShapedData(obj, shape, hooks);

    const out: Record<string, any> = {[HANDLE_MARKER]: id};
    if (sendShape) out[SHAPE_FIELD] = [shape.keys, shape.kinds];
    out[SHAPE_ID_FIELD] = shapeId;
    if (modelNameId !== undefined) {
      if (sendModelName !== undefined) {
        out[MODEL_NAME_FIELD] = [modelNameId, modelName];
      }
      out[MODEL_NAME_ID_FIELD] = modelNameId;
    }
    out[DATA_FIELD] = data;
    return out;
  }

  private allocateObjectId(obj: object): string {
    const id = this.handles.allocateId('o');
    this.handles.register(id, obj);
    return id;
  }

  private emitPlainObject(
    obj: Record<string, unknown>,
    hooks: SerializeHooks,
  ): any {
    // Pure JSON: emit inline, no id, no shape. Nested Signals/Models/etc.
    // still get `@H` markers through the walk. `_`-prefixed keys stripped.
    const out: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
      if (key[0] === '_') continue;
      const v = this.walk(obj[key], hooks);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }

  private emitShapedData(
    obj: Record<string, unknown>,
    shape: Shape,
    hooks: SerializeHooks,
  ): any[] {
    const data = new Array(shape.keys.length);
    for (let i = 0; i < shape.keys.length; i++) {
      const key = shape.keys[i];
      const v = obj[key];
      // Shape kinds are 1 for signal, 0 otherwise — either way we recurse.
      // The kind byte is for the hydrator's slot wiring; serialization just
      // walks the value and lets each handle kind self-describe.
      const walked = this.walk(v, hooks);
      data[i] = walked === undefined ? null : walked;
    }
    return data;
  }
}
