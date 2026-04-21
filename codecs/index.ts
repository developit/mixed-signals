/**
 * Per-type codecs for rich JS types that neither plain JSON nor the core
 * protocol round-trips on its own. Each codec is a pair of pure functions
 * with matching `undefined`-means-pass-through semantics, composable with
 * `??`:
 *
 *   import {encodeMap, encodeSet, decodeMap, decodeSet} from 'mixed-signals/codecs';
 *   const encode = (v) => encodeMap(v) ?? encodeSet(v);
 *   const decode = (v) => decodeMap(v) ?? decodeSet(v);
 *   const transport: StringTransport = { encode, decode, send, onMessage };
 *
 * Pre-composed `encode` / `decode` bundles re-export all default codecs in
 * one call for the common case:
 *
 *   import {encode, decode} from 'mixed-signals/codecs';
 *   const transport: StringTransport = { encode, decode, send, onMessage };
 *
 * Codecs operate at the object-tree level, between the library's serializer
 * (which emits `@H` markers for handles) and the library's stringify step
 * (which happens inside the string transport). A codec's `encode*` runs
 * top-down during the outbound walk; the library recurses into the returned
 * tagged body so nested signals / handles still get `@H`-emitted. `decode*`
 * runs bottom-up during the inbound walk, so by the time it sees
 * `{@T: 'map', d: [...]}`, the `d` entries have already been hydrated.
 */

// ───── wire marker ───────────────────────────────────────────────────────

/** Reserved field the library uses for codec-tagged values. */
const T = '@T';

// ───── base64 (dependency-free, works in Node 16+ / browsers / workers) ──

const CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid the argument-count limit on `String.fromCharCode`.
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ───── typed-array codec (consolidated) ──────────────────────────────────

/**
 * Every TypedArray subtype and `DataView` share the same wire shape — bytes
 * as base64 plus the constructor name. Endianness is host-native; modern
 * targets (x86/x64/ARM in their standard modes) are all little-endian so
 * this round-trips faithfully between any realistic peer pair. Cross-endian
 * RPC between different-endian hosts is not in scope.
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

export const encodeTypedArray = (v: unknown) => {
  if (!ArrayBuffer.isView(v)) return undefined;
  const ctor = (v as {constructor: {name: string}}).constructor.name;
  if (!(ctor in TYPED_ARRAY_CTORS)) return undefined;
  const bytes = new Uint8Array(
    (v as ArrayBufferView).buffer,
    (v as ArrayBufferView).byteOffset,
    (v as ArrayBufferView).byteLength,
  );
  return {[T]: 'ta', t: ctor, d: bytesToBase64(bytes)};
};

export const decodeTypedArray = (v: any) => {
  if (v?.[T] !== 'ta') return undefined;
  const Ctor = TYPED_ARRAY_CTORS[v.t];
  if (!Ctor) return undefined;
  const bytes = base64ToBytes(v.d);
  if (Ctor === DataView) return new DataView(bytes.buffer);
  if (Ctor === Uint8Array) return bytes;
  // Other typed arrays share the buffer; length is in elements, not bytes.
  return new (Ctor as Uint8ArrayConstructor)(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / (Ctor as typeof Uint8Array).BYTES_PER_ELEMENT,
  );
};

// ───── ArrayBuffer ───────────────────────────────────────────────────────

export const encodeArrayBuffer = (v: unknown) => {
  if (!(v instanceof ArrayBuffer)) return undefined;
  return {[T]: 'ab', d: bytesToBase64(new Uint8Array(v))};
};

export const decodeArrayBuffer = (v: any) => {
  if (v?.[T] !== 'ab') return undefined;
  return base64ToBytes(v.d).buffer;
};

// ───── Map ───────────────────────────────────────────────────────────────

export const encodeMap = (v: unknown) =>
  v instanceof Map ? {[T]: 'map', d: Array.from(v.entries())} : undefined;

export const decodeMap = (v: any) =>
  v?.[T] === 'map' ? new Map(v.d) : undefined;

// ───── Set ───────────────────────────────────────────────────────────────

export const encodeSet = (v: unknown) =>
  v instanceof Set ? {[T]: 'set', d: Array.from(v)} : undefined;

export const decodeSet = (v: any) =>
  v?.[T] === 'set' ? new Set(v.d) : undefined;

// ───── Date ──────────────────────────────────────────────────────────────

// Date has a built-in `.toJSON()` so the serializer already handles the
// outbound direction losslessly as an ISO string. A codec gives you a Date
// instance on the other side instead of a string — useful if downstream
// code does arithmetic on it. Registering `encodeDate` / `decodeDate` is
// opt-in; without it you get the (also-fine) ISO-string round-trip.
export const encodeDate = (v: unknown) =>
  v instanceof Date ? {[T]: 'date', d: v.getTime()} : undefined;

export const decodeDate = (v: any) =>
  v?.[T] === 'date' ? new Date(v.d) : undefined;

// ───── RegExp ────────────────────────────────────────────────────────────

export const encodeRegExp = (v: unknown) =>
  v instanceof RegExp ? {[T]: 're', d: v.source, f: v.flags} : undefined;

export const decodeRegExp = (v: any) =>
  v?.[T] === 're' ? new RegExp(v.d, v.f) : undefined;

// ───── Error ─────────────────────────────────────────────────────────────

// Rebuilds as a plain `Error` regardless of subclass; recovering the exact
// class (TypeError etc.) cross-boundary would require a registry we don't
// want. `.name` is preserved on the rebuilt instance for `err.name` checks.
export const encodeError = (v: unknown) => {
  if (!(v instanceof Error)) return undefined;
  return {
    [T]: 'err',
    n: v.name,
    m: v.message,
    // `stack` is non-enumerable on most engines and not always meaningful
    // across a process boundary; include it when present but don't require.
    ...(v.stack ? {s: v.stack} : null),
  };
};

export const decodeError = (v: any) => {
  if (v?.[T] !== 'err') return undefined;
  const e = new Error(v.m);
  if (v.n) e.name = v.n;
  if (v.s) e.stack = v.s;
  return e;
};

// ───── URL ───────────────────────────────────────────────────────────────

export const encodeURL = (v: unknown) =>
  v instanceof URL ? {[T]: 'url', d: v.href} : undefined;

export const decodeURL = (v: any) =>
  v?.[T] === 'url' ? new URL(v.d) : undefined;

// ───── BigInt ────────────────────────────────────────────────────────────

export const encodeBigInt = (v: unknown) =>
  typeof v === 'bigint' ? {[T]: 'bi', d: v.toString()} : undefined;

export const decodeBigInt = (v: any) =>
  v?.[T] === 'bi' ? BigInt(v.d) : undefined;

// ───── default bundles ───────────────────────────────────────────────────

/**
 * Default encode chain covering every codec shipped in this module.
 * Compose with a user-defined codec via `??`:
 *
 *   const encode = (v) => encodeMoney(v) ?? encodeDefaults(v);
 */
export const encode = (v: unknown) =>
  encodeTypedArray(v) ??
  encodeArrayBuffer(v) ??
  encodeMap(v) ??
  encodeSet(v) ??
  encodeDate(v) ??
  encodeRegExp(v) ??
  encodeError(v) ??
  encodeURL(v) ??
  encodeBigInt(v);

/** Default decode chain matching the `encode` bundle above. */
export const decode = (v: unknown) =>
  decodeTypedArray(v) ??
  decodeArrayBuffer(v) ??
  decodeMap(v) ??
  decodeSet(v) ??
  decodeDate(v) ??
  decodeRegExp(v) ??
  decodeError(v) ??
  decodeURL(v) ??
  decodeBigInt(v);
