import {signal} from '@preact/signals-core';
import {describe, expect, it} from 'vitest';
import {createModel} from '../../server/model.ts';
import {Handles} from '../../shared/handles.ts';
import {HANDLE_MARKER} from '../../shared/protocol.ts';
import {Serializer} from '../../shared/serialize.ts';

function serialize(value: any, peerId = 'c1') {
  const h = new Handles();
  const s = new Serializer(h);
  const signals: string[] = [];
  const handles: string[] = [];
  const promises: string[] = [];
  const out = s.serialize(value, {
    peerId,
    onSignalEmitted: (id) => signals.push(id),
    onHandleEmitted: (id) => handles.push(id),
    onPromiseEmitted: (id) => promises.push(id),
  });
  return {out, signals, handles, promises, h};
}

describe('Serializer: basics', () => {
  it('primitives pass through', () => {
    expect(serialize(42).out).toBe(42);
    expect(serialize('hi').out).toBe('hi');
    expect(serialize(null).out).toBe(null);
    expect(serialize(true).out).toBe(true);
  });

  it('plain data objects are inlined as JSON with no @H', () => {
    const {out} = serialize({a: 1, b: 'two', c: [1, 2, 3]});
    expect(out).toEqual({a: 1, b: 'two', c: [1, 2, 3]});
    expect(out[HANDLE_MARKER]).toBeUndefined();
  });

  it('plain data objects with nested signals stay inline; the signals get @H', () => {
    const {out, signals} = serialize({name: signal('x')});
    expect(out[HANDLE_MARKER]).toBeUndefined();
    expect(out.name[HANDLE_MARKER]).toMatch(/^s\d+$/);
    expect(out.name.v).toBe('x');
    expect(signals).toHaveLength(1);
  });

  it('plain data with a method upgrades to an ad-hoc o handle (keyed d, no c)', () => {
    const {out, handles} = serialize({
      count: 5,
      next() {
        return 6;
      },
    });
    expect(out[HANDLE_MARKER]).toMatch(/^o\d+$/);
    expect(out.c).toBeUndefined();
    expect(out.p).toBeUndefined();
    // `d` is a keyed object for ad-hoc handles; `next` is omitted.
    expect(out.d).toEqual({count: 5});
    expect(handles).toHaveLength(1);
  });

  it('arrays are emitted as arrays with recursed items', () => {
    const {out} = serialize([1, signal(2), {a: 3}]);
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]).toBe(1);
    expect(out[1][HANDLE_MARKER]).toMatch(/^s/);
    expect(out[1].v).toBe(2);
    expect(out[2]).toEqual({a: 3});
  });
});

describe('Serializer: signals (tier 1)', () => {
  it('signals get an @H:s<n> handle with inline value', () => {
    const s = signal(7);
    const {out, signals} = serialize(s);
    expect(out[HANDLE_MARKER]).toMatch(/^s\d+$/);
    expect(out.v).toBe(7);
    expect(signals).toHaveLength(1);
  });

  it('re-emitting the same signal to the same peer sends a short reference', () => {
    const s = signal(7);
    const h = new Handles();
    const ser = new Serializer(h);
    const first = ser.serialize(s, {peerId: 'c1'});
    const second = ser.serialize(s, {peerId: 'c1'});
    expect(first[HANDLE_MARKER]).toBe(second[HANDLE_MARKER]);
    expect(first.v).toBe(7);
    expect(second.v).toBeUndefined();
  });

  it('signals do NOT participate in refcounts (tier 1 uses @W/@U instead)', () => {
    const {h, out} = serialize(signal(0));
    const id = (out as any)[HANDLE_MARKER] as string;
    expect(h.get(id)?.refs.size).toBe(0);
  });
});

describe('Serializer: cached classes (Models, user classes)', () => {
  it('first emission: c is "<id>#<name>" string, p is comma-separated keys, d is positional', () => {
    const M = createModel<{
      a: ReturnType<typeof signal<number>>;
      b: ReturnType<typeof signal<string>>;
    }>('M', () => ({a: signal(1), b: signal('x')}));
    const instance = new M();

    const h = new Handles();
    const ser = new Serializer(h);
    const first = ser.serialize(instance, {peerId: 'c1'});

    expect(first[HANDLE_MARKER]).toMatch(/^o\d+$/);
    expect(typeof first.c).toBe('string');
    expect(first.c).toMatch(/^\d+#M$/);
    expect(first.p).toBe('a,b');
    expect(Array.isArray(first.d)).toBe(true);
    expect(first.d).toHaveLength(2);
  });

  it('subsequent emission: c becomes numeric, p is omitted, d stays positional', () => {
    const M = createModel('M', () => ({a: signal(1), b: signal('x')}));
    const instance = new M();
    const h = new Handles();
    const ser = new Serializer(h);
    const first = ser.serialize(instance, {peerId: 'c1'});
    const classIdFromString = Number.parseInt(
      (first.c as string).split('#')[0],
      10,
    );

    const second = ser.serialize(instance, {peerId: 'c1'});
    expect(second[HANDLE_MARKER]).toBe(first[HANDLE_MARKER]);
    // Same-instance reuse: short reference, no c/p/d at all.
    expect(second.c).toBeUndefined();
    expect(second.p).toBeUndefined();
    expect(second.d).toBeUndefined();

    // Different instance of the same class — class cache hits:
    const third = ser.serialize(new M(), {peerId: 'c1'});
    expect(third.c).toBe(classIdFromString);
    expect(third.p).toBeUndefined();
    expect(third.d).toHaveLength(2);
  });

  it('non-createModel class auto-upgrades and caches by ctor', () => {
    class Project {
      id = signal('1');
      rename(next: string) {
        this.id.value = next;
      }
    }
    const h = new Handles();
    const ser = new Serializer(h);
    const first = ser.serialize(new Project(), {peerId: 'c1'});

    expect(first[HANDLE_MARKER]).toMatch(/^o\d+$/);
    // Anonymous (no createModel name) but stable ctor → c is "<id>" only.
    expect(typeof first.c).toBe('string');
    expect(first.c).toMatch(/^\d+$/);
    expect(first.p).toBe('id');
    expect(first.d).toHaveLength(1);

    // Second instance — class cache hits, numeric c:
    const second = ser.serialize(new Project(), {peerId: 'c1'});
    expect(typeof second.c).toBe('number');
    expect(second.p).toBeUndefined();
  });

  it('class with no methods stays pure JSON', () => {
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
    }
    const {out} = serialize(new Point(3, 4));
    expect(out[HANDLE_MARKER]).toBeUndefined();
    expect(out).toEqual({x: 3, y: 4});
  });

  it('methods are omitted from p and d; they are trap-dispatched', () => {
    const M = createModel('Thing', () => ({
      count: signal(0),
      increment() {},
      add(_x: number) {},
    }));
    const {out} = serialize(new M());
    expect(out.p).toBe('count');
    expect(out.d).toHaveLength(1);
  });

  it('class instances with differing shapes get distinct class ids', () => {
    // Hand-written class with a conditionally-present own property.
    class Config {
      url = 'x';
      method() {}
      withRegion() {
        (this as any).region = 'us';
        return this;
      }
    }
    const h = new Handles();
    const ser = new Serializer(h);
    const a = ser.serialize(new Config(), {peerId: 'c1'});
    const b = ser.serialize(new Config().withRegion(), {peerId: 'c1'});
    // Different own-property sets → different class ids. First one hits the
    // ctor cache, second falls through because its shape doesn't match.
    const idA = Number.parseInt((a.c as string).split('#')[0], 10);
    const idB = Number.parseInt((b.c as string).split('#')[0], 10);
    expect(idA).not.toBe(idB);
    expect(a.p).toBe('url');
    expect(b.p).toBe('url,region');
  });

  it('a class with a comma in a property name throws a clear error', () => {
    // Hand-build a class-ctor with a weird own key so we hit the cached-class path.
    class Weird {
      constructor() {
        (this as any)['foo,bar'] = 1;
      }
      method() {}
    }
    expect(() => serialize(new Weird())).toThrow(/contains ','/);
  });
});

describe('Serializer: functions (tier 2)', () => {
  it('free functions become @H:f<n> handles and retain', () => {
    const {out, handles, h} = serialize(() => 1);
    expect(out[HANDLE_MARKER]).toMatch(/^f\d+$/);
    expect(handles).toHaveLength(1);
    const id = (out as any)[HANDLE_MARKER] as string;
    expect(h.get(id)?.refs.get('c1')).toBe(1);
  });
});

describe('Serializer: promises (tier 3)', () => {
  it('promises get an @H:p<n> marker without entering the Handles registry', () => {
    const {out, promises, h} = serialize(Promise.resolve(1));
    expect(out[HANDLE_MARKER]).toMatch(/^p\d+$/);
    expect(promises).toHaveLength(1);
    const id = (out as any)[HANDLE_MARKER] as string;
    // Tier 3: no Handle entry, no refcount, no release path.
    expect(h.get(id)).toBeUndefined();
  });

  it('the same Promise re-emits with the same pid (no double settlement)', () => {
    const p = Promise.resolve(1);
    const h = new Handles();
    const ser = new Serializer(h);
    const fired: string[] = [];
    const hooks = {
      peerId: 'c1',
      onPromiseEmitted: (id: string) => fired.push(id),
    };
    const first = ser.serialize(p, hooks);
    const second = ser.serialize(p, hooks);
    expect(first[HANDLE_MARKER]).toBe(second[HANDLE_MARKER]);
    expect(fired).toHaveLength(1);
  });
});

describe('Serializer: toJSON opt-out', () => {
  it('respects .toJSON() on values, matching JSON.stringify semantics', () => {
    const date = new Date('2024-01-01T00:00:00.000Z');
    const {out} = serialize(date);
    expect(typeof out).toBe('string');
    expect(out).toBe('2024-01-01T00:00:00.000Z');
  });

  it('a user-defined toJSON opts out of handle upgrading', () => {
    class Opinion {
      say() {
        return 'hi';
      }
      toJSON() {
        return {plain: true};
      }
    }
    const {out} = serialize(new Opinion());
    expect(out[HANDLE_MARKER]).toBeUndefined();
    expect(out).toEqual({plain: true});
  });
});
