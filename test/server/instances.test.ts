import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {Instances} from '../../server/instances.ts';

describe('Instances', () => {
  it('register and get retrieves instance by id', () => {
    const inst = new Instances();
    const obj = {foo: 'bar'};
    inst.register('abc', obj);
    assert.equal(inst.get('abc'), obj);
  });

  it('getId returns id for registered object', () => {
    const inst = new Instances();
    const obj = {foo: 'bar'};
    inst.register('abc', obj);
    assert.equal(inst.getId(obj), 'abc');
  });

  it('getId returns undefined for non-object values', () => {
    const inst = new Instances();
    assert.equal(inst.getId('string'), undefined);
    assert.equal(inst.getId(42), undefined);
    assert.equal(inst.getId(null), undefined);
    assert.equal(inst.getId(undefined), undefined);
  });

  it('getId returns undefined for unregistered object', () => {
    const inst = new Instances();
    assert.equal(inst.getId({unknown: true}), undefined);
  });

  it('remove deletes from both maps', () => {
    const inst = new Instances();
    const obj = {x: 1};
    inst.register('1', obj);
    assert.equal(inst.get('1'), obj);
    assert.equal(inst.getId(obj), '1');

    inst.remove('1');
    assert.equal(inst.get('1'), undefined);
    assert.equal(inst.getId(obj), undefined);
  });

  it('remove is a no-op for unknown id', () => {
    const inst = new Instances();
    inst.remove('nonexistent'); // should not throw
  });

  it('nextId returns incrementing string IDs', () => {
    const inst = new Instances();
    assert.equal(inst.nextId(), '1');
    assert.equal(inst.nextId(), '2');
    assert.equal(inst.nextId(), '3');
  });

  it('nextId skips IDs already in use', () => {
    const inst = new Instances();
    inst.register('1', {a: 1});
    inst.register('2', {b: 2});
    assert.equal(inst.nextId(), '3');
  });

  it('register overwrites existing entry at same id', () => {
    const inst = new Instances();
    const obj1 = {v: 1};
    const obj2 = {v: 2};
    inst.register('x', obj1);
    inst.register('x', obj2);
    assert.equal(inst.get('x'), obj2);
    assert.equal(inst.getId(obj2), 'x');
  });

  it('handles registering non-object values (no reverse lookup)', () => {
    const inst = new Instances();
    inst.register('num', 42 as any);
    assert.equal(inst.get('num'), 42);
    assert.equal(inst.getId(42 as any), undefined);
  });
});
