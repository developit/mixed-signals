import {describe, expect, it} from 'vitest';
import {Instances} from '../../server/instances.ts';

describe('Instances', () => {
  it('register and get retrieves instance by id', () => {
    const inst = new Instances();
    const obj = {foo: 'bar'};
    inst.register('abc', obj);
    expect(inst.get('abc')).toBe(obj);
  });

  it('getId returns id for registered object', () => {
    const inst = new Instances();
    const obj = {foo: 'bar'};
    inst.register('abc', obj);
    expect(inst.getId(obj)).toBe('abc');
  });

  it('getId returns undefined for non-object values', () => {
    const inst = new Instances();
    expect(inst.getId('string')).toBeUndefined();
    expect(inst.getId(42)).toBeUndefined();
    expect(inst.getId(null)).toBeUndefined();
    expect(inst.getId(undefined)).toBeUndefined();
  });

  it('getId returns undefined for unregistered object', () => {
    const inst = new Instances();
    expect(inst.getId({unknown: true})).toBeUndefined();
  });

  it('remove deletes from both maps', () => {
    const inst = new Instances();
    const obj = {x: 1};
    inst.register('1', obj);
    expect(inst.get('1')).toBe(obj);
    expect(inst.getId(obj)).toBe('1');

    inst.remove('1');
    expect(inst.get('1')).toBeUndefined();
    expect(inst.getId(obj)).toBeUndefined();
  });

  it('remove is a no-op for unknown id', () => {
    const inst = new Instances();
    inst.remove('nonexistent'); // should not throw
  });

  it('nextId returns incrementing string IDs', () => {
    const inst = new Instances();
    expect(inst.nextId()).toBe('1');
    expect(inst.nextId()).toBe('2');
    expect(inst.nextId()).toBe('3');
  });

  it('allocates the next available id without collisions', () => {
    const inst = new Instances();
    inst.register('1', {});
    inst.register('3', {});
    expect(inst.nextId()).toBe('2');
    expect(inst.nextId()).toBe('4');
  });

  it('register overwrites existing entry at same id', () => {
    const inst = new Instances();
    const obj1 = {v: 1};
    const obj2 = {v: 2};
    inst.register('x', obj1);
    inst.register('x', obj2);
    expect(inst.get('x')).toBe(obj2);
    expect(inst.getId(obj2)).toBe('x');
  });

  it('does not create reverse lookups for non-object values', () => {
    const inst = new Instances();
    inst.register('num', 42 as any);
    expect(inst.get('num')).toBe(42);
    expect(inst.getId(42 as any)).toBeUndefined();

    inst.register('value', 'plain-text');
    expect(inst.get('value')).toBe('plain-text');
    expect(inst.getId('plain-text')).toBeUndefined();
  });
});
