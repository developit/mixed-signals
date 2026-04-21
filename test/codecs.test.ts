import {describe, expect, it} from 'vitest';
import {decode, encode} from '../codecs/index.ts';

function roundTrip<T>(value: T): T {
  const encoded = encode(value);
  expect(encoded).toBeDefined();
  // Encoded form should be plain-JSON-serializable (no live objects).
  expect(JSON.stringify(encoded)).toBeTypeOf('string');
  const parsed = JSON.parse(JSON.stringify(encoded));
  const decoded = decode(parsed);
  expect(decoded).toBeDefined();
  return decoded as T;
}

describe('encode / decode — per-type round-trips', () => {
  it('Map', () => {
    const m = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const d = roundTrip(m);
    expect(d).toBeInstanceOf(Map);
    expect([...d.entries()]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('Set', () => {
    const s = new Set(['x', 'y', 'z']);
    const d = roundTrip(s);
    expect(d).toBeInstanceOf(Set);
    expect([...d]).toEqual(['x', 'y', 'z']);
  });

  it('Date', () => {
    const src = new Date('2026-01-01T00:00:00Z');
    const d = roundTrip(src);
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBe(src.getTime());
  });

  it('RegExp with flags', () => {
    const r = /foo.*bar/giu;
    const d = roundTrip(r);
    expect(d).toBeInstanceOf(RegExp);
    expect(d.source).toBe('foo.*bar');
    expect(d.flags).toBe('giu');
  });

  it('Error preserves name, message, stack', () => {
    const e = new TypeError('boom');
    const d = roundTrip(e);
    expect(d).toBeInstanceOf(Error);
    expect(d.name).toBe('TypeError');
    expect(d.message).toBe('boom');
    expect(d.stack).toBe(e.stack);
  });

  it('URL', () => {
    const u = new URL('https://example.com/path?x=1#frag');
    const d = roundTrip(u);
    expect(d).toBeInstanceOf(URL);
    expect(d.href).toBe(u.href);
  });

  it('BigInt', () => {
    const d = roundTrip(12345678901234567890n);
    expect(d).toBe(12345678901234567890n);
  });

  it('ArrayBuffer', () => {
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([1, 2, 3, 4]);
    const d = roundTrip(ab);
    expect(d).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(d)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('every TypedArray subtype + DataView via the consolidated tag', () => {
    const cases: Array<[string, ArrayBufferView, (d: any) => unknown]> = [
      ['Int8Array', new Int8Array([-1, 0, 127]), (d) => Array.from(d)],
      ['Uint8Array', new Uint8Array([0, 128, 255]), (d) => Array.from(d)],
      [
        'Uint8ClampedArray',
        new Uint8ClampedArray([0, 128, 255]),
        (d) => Array.from(d),
      ],
      ['Int16Array', new Int16Array([-1, 0, 32767]), (d) => Array.from(d)],
      ['Uint16Array', new Uint16Array([0, 32768, 65535]), (d) => Array.from(d)],
      ['Int32Array', new Int32Array([-1, 0, 2147483647]), (d) => Array.from(d)],
      [
        'Uint32Array',
        new Uint32Array([0, 2147483648, 4294967295]),
        (d) => Array.from(d),
      ],
      [
        'Float32Array',
        new Float32Array([1.5, -2.25, 3.125]),
        (d) => Array.from(d),
      ],
      ['Float64Array', new Float64Array([Math.PI, Math.E]), (d) => Array.from(d)],
      [
        'BigInt64Array',
        new BigInt64Array([1n, -1n, 9007199254740993n]),
        (d) => Array.from(d),
      ],
      [
        'BigUint64Array',
        new BigUint64Array([1n, 18446744073709551615n]),
        (d) => Array.from(d),
      ],
      [
        'DataView',
        new DataView(new Uint8Array([1, 2, 3, 4]).buffer),
        (d) => (d as DataView).byteLength,
      ],
    ];
    for (const [name, input, extract] of cases) {
      const d = roundTrip(input);
      expect(d.constructor.name).toBe(name);
      if (input instanceof DataView) {
        expect(extract(d)).toBe(4);
      } else {
        expect(extract(d)).toEqual(Array.from(input as any));
      }
    }
  });

  it('TypedArray preserves byteOffset window', () => {
    const buf = new ArrayBuffer(16);
    new Uint8Array(buf).set([10, 20, 30, 40, 50, 60, 70, 80]);
    const view = new Uint8Array(buf, 2, 4); // [30, 40, 50, 60]
    const d = roundTrip(view);
    expect(Array.from(d)).toEqual([30, 40, 50, 60]);
  });
});

describe('encode / decode — pass-through semantics', () => {
  it('encode returns undefined for primitives and plain objects', () => {
    expect(encode('str')).toBeUndefined();
    expect(encode(42)).toBeUndefined();
    expect(encode(true)).toBeUndefined();
    expect(encode(null)).toBeUndefined();
    expect(encode({a: 1})).toBeUndefined();
    expect(encode([1, 2, 3])).toBeUndefined();
  });

  it('decode returns undefined for non-tagged values', () => {
    expect(decode('str')).toBeUndefined();
    expect(decode(null)).toBeUndefined();
    expect(decode({})).toBeUndefined();
    expect(decode({'@T': 'nope-not-a-tag', d: 1})).toBeUndefined();
    expect(decode([1, 2, 3])).toBeUndefined();
  });
});

describe('encode / decode — composition with user codecs', () => {
  it('user type can chain ahead of defaults via `??`', () => {
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

    // User type round-trips via the user codec.
    const priceEnc = enc(new Money(9.99, 'USD'));
    const price = dec(priceEnc) as Money;
    expect(price).toBeInstanceOf(Money);
    expect(price.amount).toBe(9.99);
    expect(price.currency).toBe('USD');

    // Defaults still flow through for non-matching values.
    const mapEnc = enc(new Map([['k', 1]]));
    const m = dec(mapEnc) as Map<string, number>;
    expect(m).toBeInstanceOf(Map);
    expect(m.get('k')).toBe(1);
  });

  it('subset-only encode/decode (user-written) interops with the library @T format', () => {
    // A user who wants only Map + Set can write their own 6-liner; the `@T`
    // tags they produce are interchangeable with this module's defaults.
    const miniEnc = (v: unknown) =>
      v instanceof Map
        ? {'@T': 'map', d: Array.from(v.entries())}
        : v instanceof Set
          ? {'@T': 'set', d: Array.from(v)}
          : undefined;

    const m = miniEnc(new Map([['a', 1]]));
    expect(decode(m)).toBeInstanceOf(Map);

    const s = miniEnc(new Set([1, 2]));
    expect(decode(s)).toBeInstanceOf(Set);
  });
});
