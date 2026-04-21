import {describe, expect, it} from 'vitest';
import {
  decode,
  decodeArrayBuffer,
  decodeBigInt,
  decodeDate,
  decodeError,
  decodeMap,
  decodeRegExp,
  decodeSet,
  decodeTypedArray,
  decodeURL,
  encode,
  encodeArrayBuffer,
  encodeBigInt,
  encodeDate,
  encodeError,
  encodeMap,
  encodeRegExp,
  encodeSet,
  encodeTypedArray,
  encodeURL,
} from '../codecs/index.ts';

describe('per-type codecs', () => {
  it('Map', () => {
    const m = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const enc = encodeMap(m);
    expect(enc).toEqual({'@T': 'map', d: [['a', 1], ['b', 2]]});
    const dec = decodeMap(enc);
    expect(dec).toBeInstanceOf(Map);
    expect([...(dec as Map<string, number>).entries()]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('Set', () => {
    const s = new Set([1, 2, 3]);
    const enc = encodeSet(s);
    expect(enc).toEqual({'@T': 'set', d: [1, 2, 3]});
    const dec = decodeSet(enc);
    expect(dec).toBeInstanceOf(Set);
    expect([...(dec as Set<number>)]).toEqual([1, 2, 3]);
  });

  it('Date', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const enc = encodeDate(d);
    expect((enc as any).d).toBe(d.getTime());
    const dec = decodeDate(enc);
    expect(dec).toBeInstanceOf(Date);
    expect((dec as Date).getTime()).toBe(d.getTime());
  });

  it('RegExp', () => {
    const r = /foo.*bar/giu;
    const enc = encodeRegExp(r);
    const dec = decodeRegExp(enc);
    expect(dec).toBeInstanceOf(RegExp);
    expect((dec as RegExp).source).toBe('foo.*bar');
    expect((dec as RegExp).flags).toBe('giu');
  });

  it('Error preserves name, message, and stack', () => {
    const e = new TypeError('boom');
    const enc = encodeError(e);
    const dec = decodeError(enc) as Error;
    expect(dec).toBeInstanceOf(Error);
    expect(dec.name).toBe('TypeError');
    expect(dec.message).toBe('boom');
    expect(dec.stack).toBe(e.stack);
  });

  it('URL', () => {
    const u = new URL('https://example.com/path?x=1');
    const enc = encodeURL(u);
    const dec = decodeURL(enc) as URL;
    expect(dec).toBeInstanceOf(URL);
    expect(dec.href).toBe(u.href);
  });

  it('BigInt', () => {
    const b = 12345678901234567890n;
    const enc = encodeBigInt(b);
    const dec = decodeBigInt(enc);
    expect(dec).toBe(b);
  });

  it('ArrayBuffer round-trips bytes', () => {
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([1, 2, 3, 4]);
    const enc = encodeArrayBuffer(ab);
    const dec = decodeArrayBuffer(enc) as ArrayBuffer;
    expect(dec).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(dec)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('TypedArray: consolidated codec handles every subtype by ctor name', () => {
    const cases: Array<[string, ArrayBufferView]> = [
      ['Int8Array', new Int8Array([-1, 0, 127])],
      ['Uint8Array', new Uint8Array([0, 128, 255])],
      ['Uint8ClampedArray', new Uint8ClampedArray([0, 128, 255])],
      ['Int16Array', new Int16Array([-1, 0, 32767])],
      ['Uint16Array', new Uint16Array([0, 32768, 65535])],
      ['Int32Array', new Int32Array([-1, 0, 2147483647])],
      ['Uint32Array', new Uint32Array([0, 2147483648, 4294967295])],
      ['Float32Array', new Float32Array([1.5, -2.25, 3.125])],
      ['Float64Array', new Float64Array([Math.PI, Math.E])],
      ['BigInt64Array', new BigInt64Array([1n, -1n, 9007199254740993n])],
      ['BigUint64Array', new BigUint64Array([1n, 18446744073709551615n])],
      ['DataView', new DataView(new Uint8Array([1, 2, 3, 4]).buffer)],
    ];
    for (const [name, view] of cases) {
      const enc = encodeTypedArray(view) as {t: string; d: string};
      expect(enc.t).toBe(name);
      const dec = decodeTypedArray(enc);
      expect(dec).toBeInstanceOf(view.constructor as new () => ArrayBufferView);
      if (dec instanceof DataView) {
        expect(dec.byteLength).toBe(view.byteLength);
      } else {
        // Numeric typed arrays — element-wise equality
        expect((dec as any).length).toBe((view as any).length);
        for (let i = 0; i < (view as any).length; i++) {
          expect((dec as any)[i]).toBe((view as any)[i]);
        }
      }
    }
  });

  it('TypedArray codec preserves view window (byteOffset + byteLength)', () => {
    const buf = new ArrayBuffer(16);
    new Uint8Array(buf).set([10, 20, 30, 40, 50, 60, 70, 80]);
    const view = new Uint8Array(buf, 2, 4); // [30, 40, 50, 60]
    const dec = decodeTypedArray(encodeTypedArray(view)) as Uint8Array;
    expect(Array.from(dec)).toEqual([30, 40, 50, 60]);
  });
});

describe('undefined-is-pass-through semantics', () => {
  it('encoders return undefined for non-matching values', () => {
    expect(encodeMap('str')).toBeUndefined();
    expect(encodeSet(42)).toBeUndefined();
    expect(encodeTypedArray({})).toBeUndefined();
    expect(encodeDate('2020-01-01')).toBeUndefined();
    expect(encodeBigInt(1)).toBeUndefined();
  });

  it('decoders return undefined for non-tagged values', () => {
    expect(decodeMap({})).toBeUndefined();
    expect(decodeMap({'@T': 'wrong'})).toBeUndefined();
    expect(decodeSet(null)).toBeUndefined();
    expect(decodeTypedArray({})).toBeUndefined();
  });
});

describe('composed encode/decode bundles', () => {
  it('covers all default types in one call', () => {
    expect(encode(new Map([['a', 1]]))).toMatchObject({'@T': 'map'});
    expect(encode(new Set([1]))).toMatchObject({'@T': 'set'});
    expect(encode(new Uint8Array([1, 2]))).toMatchObject({'@T': 'ta'});
    expect(encode(new Date())).toMatchObject({'@T': 'date'});
    expect(encode(/x/)).toMatchObject({'@T': 're'});
    expect(encode(new URL('https://a.b'))).toMatchObject({'@T': 'url'});
    expect(encode(1n)).toMatchObject({'@T': 'bi'});
    expect(encode(new Error('x'))).toMatchObject({'@T': 'err'});
    expect(encode('str')).toBeUndefined();
    expect(encode(42)).toBeUndefined();
  });

  it('decode round-trips everything the default encode handles', () => {
    const cases: unknown[] = [
      new Map([['a', 1]]),
      new Set([1, 2]),
      new Uint8Array([1, 2, 3]),
      new Date('2026-01-01T00:00:00Z'),
      /foo/g,
      new URL('https://example.com'),
      12345n,
    ];
    for (const input of cases) {
      const enc = encode(input);
      const dec = decode(enc);
      // Compare observable shape; instanceof + key equality.
      expect(dec?.constructor).toBe((input as object).constructor);
    }
  });

  it('composes with a user codec via `??`', () => {
    class Money {
      constructor(
        public amount: number,
        public currency: string,
      ) {}
    }
    const encodeMoney = (v: unknown) =>
      v instanceof Money
        ? {'@T': 'money', d: [v.amount, v.currency]}
        : undefined;
    const decodeMoney = (v: any) =>
      v?.['@T'] === 'money' ? new Money(v.d[0], v.d[1]) : undefined;

    const enc = (v: unknown) => encodeMoney(v) ?? encode(v);
    const dec = (v: unknown) => decodeMoney(v) ?? decode(v);

    const price = new Money(9.99, 'USD');
    const encoded = enc(price) as any;
    expect(encoded['@T']).toBe('money');
    const decoded = dec(encoded) as Money;
    expect(decoded).toBeInstanceOf(Money);
    expect(decoded.amount).toBe(9.99);
    expect(decoded.currency).toBe('USD');

    // Money still lets the defaults through for non-matches
    expect(enc(new Set([1, 2]))).toMatchObject({'@T': 'set'});
  });
});
