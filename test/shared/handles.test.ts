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

  it('shape registry dedupes by ctor and signature', () => {
    const h = new Handles();
    class Ctor {}
    const s1 = h.shapeIdFor(Ctor, 'a:1|b:0', {keys: ['a', 'b'], kinds: [1, 0]});
    const s2 = h.shapeIdFor(Ctor, 'a:1|b:0', {keys: ['a', 'b'], kinds: [1, 0]});
    expect(s1).toBe(s2);
    const s3 = h.shapeIdFor(undefined, 'c:0', {keys: ['c'], kinds: [0]});
    expect(s3).not.toBe(s1);
  });

  it('per-client shape-sent cache', () => {
    const h = new Handles();
    expect(h.hasShape('c1', 5)).toBe(false);
    h.markShapeSent('c1', 5);
    expect(h.hasShape('c1', 5)).toBe(true);
    expect(h.hasShape('c2', 5)).toBe(false);
    // Disconnect clears
    h.releaseAllForClient('c1');
    expect(h.hasShape('c1', 5)).toBe(false);
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
