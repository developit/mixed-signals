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
import {
  classifySlot,
  type Shape,
  SLOT_HANDLE,
  SLOT_PLAIN,
  SLOT_SIGNAL,
  shapeOf,
  shapeSignature,
} from './shapes.ts';

/**
 * A brand stamped onto server-created Model constructors (by our wrapped
 * `createModel`) so the serializer can recognize "this is a named model" vs
 * "this is a plain object". Defined here to keep a single source of truth
 * that both server and client can read without a cross-module import cycle.
 */
export const MODEL_NAME_SYMBOL: unique symbol = Symbol.for(
  'mixed-signals.modelName',
) as unknown as typeof MODEL_NAME_SYMBOL;

/** Hooks the caller (server RPC) passes in to drive the serializer. */
export interface SerializeHooks {
  /** The peer id we're serializing for — drives per-peer shape/name caches. */
  peerId: string;
  /** Called on every signal we emit, so the caller can wire subscriptions. */
  onSignalEmitted?(id: string, signal: Signal<any>): void;
  /** Called on every handle we emit, so the caller can bump refcounts. */
  onHandleEmitted?(id: string): void;
  /**
   * Called on every Promise we emit. Caller should attach settlement
   * listeners that send a later frame carrying the resolved/rejected value.
   */
  onPromiseEmitted?(id: string, promise: Promise<any>): void;
  /** Called on every function we emit. */
  onFunctionEmitted?(id: string, fn: (...args: any[]) => any): void;
}

export class Serializer {
  private handles: Handles;

  constructor(handles: Handles) {
    this.handles = handles;
  }

  /**
   * Serialize a value for a specific peer. Returns a JSON-serializable tree.
   * Call JSON.stringify on the result. The output contains `@H` markers the
   * receiving side will hydrate via `Hydrator`.
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
      // Touch the handle so TTL policies see continued activity.
      this.handles.touch(brand.id);
      return {[HANDLE_MARKER]: brand.id};
    }

    if (value instanceof Signal) return this.emitSignal(value, hooks);

    if (t === 'function')
      return this.emitFunction(value as (...a: any[]) => any, hooks);

    if (t !== 'object') return value; // symbols, bigints — pass through as JSON does

    // Promises (pending or not) — everything thenable is treated as a handle.
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

    return this.emitObject(value as Record<string, unknown>, hooks);
  }

  // ───── emitters ────────────────────────────────────────────────────────────

  private emitSignal(sig: Signal<any>, hooks: SerializeHooks): any {
    let id = this.handles.idOf(sig);
    let entry = id ? this.handles.get(id) : undefined;
    if (!id || !entry) {
      id = this.handles.allocateId('s');
      entry = this.handles.register(id, sig);
    }
    hooks.onSignalEmitted?.(id, sig);
    // If the client has already hydrated this signal, emit a bare reference
    // and do not retain again — the client still owes us exactly one release.
    if (this.handles.hasSentHandle(hooks.peerId, id)) {
      return {[HANDLE_MARKER]: id};
    }
    this.handles.retain(id, hooks.peerId);
    hooks.onHandleEmitted?.(id);
    this.handles.markHandleSent(hooks.peerId, id);
    // Inline the current value so the receiver has a fully-hydrated signal
    // on the first frame (important for sync-RPC readers).
    const inner = this.walk(sig.peek(), hooks);
    return {[HANDLE_MARKER]: id, [SIGNAL_VALUE_FIELD]: inner};
  }

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

  private emitPromise(p: Promise<any>, hooks: SerializeHooks): any {
    let id = this.handles.idOf(p);
    const firstTime = !id;
    if (!id) {
      id = this.handles.allocateId('p');
      this.handles.register(id, p);
    }
    if (firstTime) hooks.onPromiseEmitted?.(id, p);
    if (!this.handles.hasSentHandle(hooks.peerId, id)) {
      this.handles.retain(id, hooks.peerId);
      hooks.onHandleEmitted?.(id);
      this.handles.markHandleSent(hooks.peerId, id);
    }
    return {[HANDLE_MARKER]: id};
  }

  private emitObject(obj: Record<string, unknown>, hooks: SerializeHooks): any {
    // Already known object — reuse id. The owning ctor determines whether this
    // is a Model (named) or a plain object (anonymous).
    let id = this.handles.idOf(obj);
    const ctor = obj.constructor as ((...a: any[]) => any) | undefined;
    const modelName =
      ctor && (ctor as any)[MODEL_NAME_SYMBOL] !== undefined
        ? ((ctor as any)[MODEL_NAME_SYMBOL] as string)
        : undefined;

    // Only allocate an id for objects that carry structural identity — either
    // they're Models (named), or the caller explicitly pre-registered them,
    // or they have at least one signal/handle slot (so reuse matters). Pure
    // JSON dictionaries are inlined without an id, which keeps wire traffic
    // minimal for plain request/response shapes.
    const shape = shapeOf(obj);
    const signature = shapeSignature(shape);
    const hasIdentity =
      !!id ||
      !!modelName ||
      shape.kinds.some((k) => k !== SLOT_PLAIN) ||
      // Safety valve: if an object has *no* keys we still prefer to inline.
      false;

    if (!hasIdentity) {
      return this.emitPlainObject(obj, shape, hooks);
    }

    if (!id) {
      id = this.handles.allocateId('o');
      this.handles.register(id, obj);
    }

    // Short-reference path: client already has the body for this handle.
    // Don't retain again — the client still owes exactly one release.
    if (this.handles.hasSentHandle(hooks.peerId, id)) {
      return {[HANDLE_MARKER]: id};
    }
    this.handles.retain(id, hooks.peerId);
    hooks.onHandleEmitted?.(id);
    this.handles.markHandleSent(hooks.peerId, id);

    const shapeId = this.handles.shapeIdFor(ctor, signature, shape);
    const sendShape = !this.handles.hasShape(hooks.peerId, shapeId);
    if (sendShape) this.handles.markShapeSent(hooks.peerId, shapeId);

    let sendModelName: number | undefined;
    if (modelName && ctor) {
      const nameId = this.handles.modelNameIdFor(ctor, modelName);
      if (!this.handles.hasModelName(hooks.peerId, nameId)) {
        sendModelName = nameId;
        this.handles.markModelNameSent(hooks.peerId, nameId);
      }
    }
    const modelNameId =
      modelName && ctor
        ? this.handles.modelNameIdFor(ctor, modelName)
        : undefined;

    const data = this.emitShapedData(obj, shape, hooks);

    const out: Record<string, any> = {[HANDLE_MARKER]: id};
    if (sendShape) {
      out[SHAPE_FIELD] = [shape.keys, shape.kinds];
    }
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

  private emitPlainObject(
    obj: Record<string, unknown>,
    shape: Shape,
    hooks: SerializeHooks,
  ): any {
    // Truly plain JSON: emit inline, no id, no shape. Receiver sees a plain
    // object. We still filter `_`-prefixed keys for parity with today.
    const out: Record<string, any> = {};
    for (let i = 0; i < shape.keys.length; i++) {
      const key = shape.keys[i];
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
      const kind = shape.kinds[i];
      if (kind === SLOT_SIGNAL) {
        data[i] = this.emitSignal(v as Signal<any>, hooks);
      } else if (kind === SLOT_HANDLE) {
        data[i] = this.walk(v, hooks);
      } else {
        // SLOT_PLAIN — recurse so nested signals/handles still flow through.
        // Small optimization: the common case (primitive) falls through the
        // walk() fast path in constant time.
        data[i] = this.walk(v, hooks);
      }
      // Null-safety for JSON.
      if (data[i] === undefined) data[i] = null;
    }
    return data;
  }
}

// Re-export for convenience.
export {classifySlot};
