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
  const out = s.serialize(value, {
    peerId,
    onSignalEmitted: (id) => signals.push(id),
    onHandleEmitted: (id) => handles.push(id),
  });
  return {out, signals, handles, h};
}

describe('Serializer', () => {
  it('primitives pass through unchanged', () => {
    expect(serialize(42).out).toBe(42);
    expect(serialize('hi').out).toBe('hi');
    expect(serialize(null).out).toBe(null);
  });

  it('plain objects with only JSON data are inlined (no id)', () => {
    const {out} = serialize({a: 1, b: 'two'});
    expect(out).toEqual({a: 1, b: 'two'});
    expect(out[HANDLE_MARKER]).toBeUndefined();
  });

  it('signals get an @H:s<n> handle with inline value', () => {
    const s = signal(7);
    const {out, signals} = serialize(s);
    expect(out['@H']).toMatch(/^s\d+$/);
    expect(out.v).toBe(7);
    expect(signals.length).toBe(1);
  });

  it('re-emitting the same signal to the same client sends a short reference', () => {
    const s = signal(7);
    const h = new Handles();
    const ser = new Serializer(h);
    const first = ser.serialize(s, {peerId: 'c1'});
    const second = ser.serialize(s, {peerId: 'c1'});
    expect(first['@H']).toBe(second['@H']);
    expect(first.v).toBe(7);
    expect(second.v).toBeUndefined(); // short ref, no inline value
  });

  it('Models emit shape + data inline on first use, only data on reuse', () => {
    const M = createModel<{
      a: ReturnType<typeof signal<number>>;
      b: ReturnType<typeof signal<string>>;
    }>('M', () => ({a: signal(1), b: signal('x')}));
    const instance = new M();

    const h = new Handles();
    const ser = new Serializer(h);
    const first = ser.serialize(instance, {peerId: 'c1'});
    expect(first['@H']).toMatch(/^o\d+$/);
    expect(first.s).toBeDefined(); // shape id
    expect(first.sh).toEqual([
      ['a', 'b'],
      [1, 1],
    ]); // kinds: signal, signal
    expect(first.n).toBeDefined(); // model-name id
    expect(first.mn).toEqual([expect.any(Number), 'M']);
    expect(first.d).toBeInstanceOf(Array);
    expect(first.d.length).toBe(2);

    // Second emission to the same client: short reference.
    const second = ser.serialize(instance, {peerId: 'c1'});
    expect(second['@H']).toBe(first['@H']);
    expect(second.sh).toBeUndefined();
    expect(second.mn).toBeUndefined();
    // Shape-id and data are not re-sent in the short-reference form.
    expect(second.s).toBeUndefined();
    expect(second.d).toBeUndefined();
  });

  it('plain objects with signal or handle slots get a shape + id', () => {
    const plain = {count: signal(0)};
    const {out} = serialize(plain);
    expect(out['@H']).toMatch(/^o\d+$/);
    expect(out.sh).toBeDefined();
    // No model-name because no createModel() on the ctor.
    expect(out.mn).toBeUndefined();
  });

  it('functions become @H:f<n> handles', () => {
    const {out, handles} = serialize(() => 1);
    expect(out['@H']).toMatch(/^f\d+$/);
    expect(handles.length).toBe(1);
  });

  it('promises become @H:p<n> handles', () => {
    const {out, handles} = serialize(Promise.resolve(1));
    expect(out['@H']).toMatch(/^p\d+$/);
    expect(handles.length).toBe(1);
  });

  it('arrays are emitted as arrays with recursed items', () => {
    const {out} = serialize([1, signal(2), {a: 3}]);
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]).toBe(1);
    expect(out[1]['@H']).toMatch(/^s/);
    expect(out[1].v).toBe(2);
    expect(out[2]).toEqual({a: 3});
  });

  it('retain/release contract: one retain per new emission, none on short refs', () => {
    const s = signal(0);
    const h = new Handles();
    const ser = new Serializer(h);
    ser.serialize(s, {peerId: 'c1'});
    const id = h.idOf(s)!;
    expect(h.get(id)?.refs.get('c1')).toBe(1);
    ser.serialize(s, {peerId: 'c1'});
    // Short reference — refcount unchanged.
    expect(h.get(id)?.refs.get('c1')).toBe(1);
    // Different client: fresh refcount.
    ser.serialize(s, {peerId: 'c2'});
    expect(h.get(id)?.refs.get('c2')).toBe(1);
  });
});
