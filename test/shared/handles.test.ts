import {describe, expect, it} from 'vitest';
import {Handles} from '../../shared/handles.ts';

describe('Handles', () => {
  it('allocates monotonic ids per kind', () => {
    const h = new Handles();
    expect(h.allocateId('s')).toBe('s1');
    expect(h.allocateId('s')).toBe('s2');
    expect(h.allocateId('o')).toBe('o1');
    expect(h.allocateId('f')).toBe('f1');
    expect(h.allocateId('p')).toBe('p1');
  });

  it('round-trips value ↔ id for objects', () => {
    const h = new Handles();
    const obj = {x: 1};
    const id = h.allocateId('o');
    h.register(id, obj);
    expect(h.idOf(obj)).toBe(id);
    expect(h.valueOf(id)).toBe(obj);
  });

  it('refcount: retain + release, reports orphaning', () => {
    const h = new Handles();
    const obj = {};
    const id = h.allocateId('o');
    h.register(id, obj);
    h.retain(id, 'a');
    h.retain(id, 'b');
    expect(h.release(id, 'a')).toBe(false); // 'b' still holds it
    expect(h.release(id, 'b')).toBe(true); // last holder
  });

  it('releaseAllForClient returns orphaned ids', () => {
    const h = new Handles();
    const a = {};
    const b = {};
    h.register('o1', a);
    h.register('o2', b);
    h.retain('o1', 'c1');
    h.retain('o2', 'c1');
    h.retain('o2', 'c2');
    const orphaned = h.releaseAllForClient('c1');
    expect(orphaned.sort()).toEqual(['o1']);
    // o2 still held by c2
    expect(h.get('o2')?.refs.size).toBe(1);
  });

  it('class registry dedupes by ctor and signature', () => {
    const h = new Handles();
    class Ctor {}
    const c1 = h.classIdFor(Ctor, 'Counter|a,b', 'Counter', ['a', 'b']);
    const c2 = h.classIdFor(Ctor, 'Counter|a,b', 'Counter', ['a', 'b']);
    expect(c1).toBe(c2);
    const c3 = h.classIdFor(undefined, '|c', null, ['c']);
    expect(c3).not.toBe(c1);
    expect(h.getClass(c1)?.keys).toEqual(['a', 'b']);
    expect(h.getClass(c1)?.name).toBe('Counter');
  });

  it('per-client class-sent cache', () => {
    const h = new Handles();
    expect(h.hasClass('c1', 5)).toBe(false);
    h.markClassSent('c1', 5);
    expect(h.hasClass('c1', 5)).toBe(true);
    expect(h.hasClass('c2', 5)).toBe(false);
    // Disconnect clears
    h.releaseAllForClient('c1');
    expect(h.hasClass('c1', 5)).toBe(false);
  });

  it('per-client handle-sent cache drives short-reference emission', () => {
    const h = new Handles();
    expect(h.hasSentHandle('c1', 'o1')).toBe(false);
    h.markHandleSent('c1', 'o1');
    expect(h.hasSentHandle('c1', 'o1')).toBe(true);
    h.releaseAllForClient('c1');
    expect(h.hasSentHandle('c1', 'o1')).toBe(false);
  });

  it('drop() removes the entry and the reverse lookup', () => {
    const h = new Handles();
    const obj = {};
    h.register('o1', obj);
    h.drop('o1');
    expect(h.valueOf('o1')).toBeUndefined();
    expect(h.idOf(obj)).toBeUndefined();
  });
});
