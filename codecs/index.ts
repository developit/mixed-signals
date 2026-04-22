/**
 * Default codecs for rich JS types that neither plain JSON nor the core
 * protocol round-trips on its own: Map, Set, every TypedArray subtype,
 * DataView, ArrayBuffer, Date, RegExp, Error, URL, BigInt.
 *
 * Usage:
 *
 *   import {encode, decode} from 'mixed-signals/codecs';
 *
 *   const transport: StringTransport = {
 *     encode, decode,
 *     send: (s) => webview.postMessage(s),
 *     onMessage: (cb) => webview.addEventListener('message',
 *       e => cb({toString: () => e.data})),
 *   };
 *
 * `encode` runs top-down during the outbound serializer walk (before
 * `emitObject` would mis-upgrade a built-in to an `@H` handle). `decode`
 * runs bottom-up during `hydrateTree` (so by the time it sees `{@T: 'map',
 * d: [...]}`, the `d` entries are already hydrated). Both use the
 * `undefined`-means-pass-through convention so users compose with `??`:
 *
 *   const myEncode = (v) => encodeMoney(v) ?? encode(v);
 *   const myDecode = (v) => decodeMoney(v) ?? decode(v);
 *
 * The `@T` tag format is part of the documented protocol; a user codec
 * for a subset of built-ins just has to produce `{'@T': 'tag', d: body}`
 * objects that `decode` knows how to resolve.
 */

/** Reserved field the library uses for codec-tagged values. */
const T = '@T';

// ───── base64: native toBase64/fromBase64 fast path + fallback ───────────

// TC39 Stage 3 — Chrome 140+, Firefox 133+, Safari 18.2+. Native is ~5×
// faster than the chunked btoa path and avoids an intermediate string.
// TS lib hasn't caught up yet; cast around the missing type decl.
type Uint8ArrayBase64Ext = Uint8Array & {toBase64(): string};
type Uint8ArrayCtorBase64Ext = Uint8ArrayConstructor & {
  fromBase64(s: string): Uint8Array;
};

const nativeToBase64 =
  typeof (Uint8Array.prototype as Uint8ArrayBase64Ext).toBase64 === 'function'
    ? (Uint8Array.prototype as Uint8ArrayBase64Ext).toBase64
    : undefined;

const nativeFromBase64 =
  typeof (Uint8Array as Uint8ArrayCtorBase64Ext).fromBase64 === 'function'
    ? (Uint8Array as Uint8ArrayCtorBase64Ext).fromBase64
    : undefined;

function bytesToBase64(bytes: Uint8Array): string {
  if (nativeToBase64) return nativeToBase64.call(bytes);
  // Direct char-by-char loop. Avoids `String.fromCharCode.apply(null, huge)`
  // arg-count limits (engine-specific, historically ~64k) without needing
  // chunking. Only runs on runtimes without native toBase64.
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  if (nativeFromBase64) return nativeFromBase64(b64);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ───── typed-array constructors (by name) ────────────────────────────────

/**
 * Every TypedArray subtype and `DataView` share one wire shape: bytes as
 * base64 plus the constructor name. Endianness is host-native; modern
 * targets (x86/x64/ARM in their standard modes) are all little-endian so
 * this round-trips faithfully between any realistic peer pair.
 */
const TYPED_ARRAY_CTORS: Record<
  string,
  | Int8ArrayConstructor
  | Uint8ArrayConstructor
  | Uint8ClampedArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor
  | Float64ArrayConstructor
  | BigInt64ArrayConstructor
  | BigUint64ArrayConstructor
  | DataViewConstructor
> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};

// ───── encode / decode ───────────────────────────────────────────────────

/**
 * Per-node outbound transform. Returns a `@T`-tagged object for any rich
 * type this bundle knows about; otherwise `undefined` (pass through).
 */
export const encode = (v: unknown): unknown => {
  // `undefined` has no JSON representation and is otherwise dropped from
  // object properties / coerced to `null` in arrays. Tag so the wire
  // faithfully distinguishes `undefined` from absent / null. The
  // decoding side is library-handled (see `hydrateTree`) because the
  // decoder's `undefined`-means-pass-through convention collides with
  // returning `undefined` as a match value.
  if (v === undefined) return {[T]: 'u'};
  if (ArrayBuffer.isView(v)) {
    const name = (v as {constructor: {name: string}}).constructor.name;
    if (name in TYPED_ARRAY_CTORS) {
      const view = v as ArrayBufferView;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      return {[T]: 'ta', t: name, d: bytesToBase64(bytes)};
    }
  }
  if (v instanceof ArrayBuffer) {
    return {[T]: 'ab', d: bytesToBase64(new Uint8Array(v))};
  }
  if (v instanceof Map) {
    return {[T]: 'map', d: Array.from(v.entries())};
  }
  if (v instanceof Set) {
    return {[T]: 'set', d: Array.from(v)};
  }
  if (v instanceof Date) {
    return {[T]: 'date', d: v.getTime()};
  }
  if (v instanceof RegExp) {
    return {[T]: 're', d: v.source, f: v.flags};
  }
  if (v instanceof Error) {
    const out: Record<string, unknown> = {[T]: 'err', n: v.name, m: v.message};
    // `stack` is non-enumerable on most engines and not always meaningful
    // across a process boundary; include when present.
    if (v.stack) out.s = v.stack;
    return out;
  }
  if (typeof URL !== 'undefined' && v instanceof URL) {
    return {[T]: 'url', d: v.href};
  }
  if (typeof v === 'bigint') {
    return {[T]: 'bi', d: v.toString()};
  }
  return undefined;
};

/**
 * Per-node inbound transform. Resolves `@T`-tagged objects produced by
 * `encode` (or any compatible codec) back to their native types. Returns
 * `undefined` when the node doesn't carry a recognized tag.
 */
export const decode = (v: unknown): unknown => {
  if (v === null || typeof v !== 'object') return undefined;
  const tag = (v as Record<string, unknown>)[T];
  if (tag === undefined) return undefined;
  const d = v as Record<string, any>;
  switch (tag) {
    case 'ta': {
      const Ctor = TYPED_ARRAY_CTORS[d.t];
      if (!Ctor) return undefined;
      const bytes = base64ToBytes(d.d);
      if (Ctor === DataView) return new DataView(bytes.buffer);
      if (Ctor === Uint8Array) return bytes;
      return new (Ctor as Uint8ArrayConstructor)(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / (Ctor as typeof Uint8Array).BYTES_PER_ELEMENT,
      );
    }
    case 'ab':
      return base64ToBytes(d.d).buffer;
    case 'map':
      return new Map(d.d);
    case 'set':
      return new Set(d.d);
    case 'date':
      return new Date(d.d);
    case 're':
      return new RegExp(d.d, d.f);
    case 'err': {
      const e = new Error(d.m);
      if (d.n) e.name = d.n;
      if (d.s) e.stack = d.s;
      return e;
    }
    case 'url':
      return new URL(d.d);
    case 'bi':
      return BigInt(d.d);
  }
  return undefined;
};
