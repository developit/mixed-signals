import {signal} from '@preact/signals-core';
import {describe, expect, it} from 'vitest';
import {
  classifySlot,
  SLOT_HANDLE,
  SLOT_PLAIN,
  SLOT_SIGNAL,
  shapeOf,
  shapeSignature,
} from '../../shared/shapes.ts';

describe('classifySlot', () => {
  it('primitives → plain', () => {
    expect(classifySlot(1)).toBe(SLOT_PLAIN);
    expect(classifySlot('a')).toBe(SLOT_PLAIN);
    expect(classifySlot(true)).toBe(SLOT_PLAIN);
    expect(classifySlot(null)).toBe(SLOT_PLAIN);
    expect(classifySlot(undefined)).toBe(SLOT_PLAIN);
  });

  it('signals → signal', () => {
    expect(classifySlot(signal(0))).toBe(SLOT_SIGNAL);
  });

  it('functions → handle', () => {
    expect(classifySlot(() => {})).toBe(SLOT_HANDLE);
  });

  it('promises → handle', () => {
    expect(classifySlot(Promise.resolve(1))).toBe(SLOT_HANDLE);
  });

  it('plain objects and arrays → plain (nested content recursed by serializer)', () => {
    expect(classifySlot({a: 1})).toBe(SLOT_PLAIN);
    expect(classifySlot([1, 2, 3])).toBe(SLOT_PLAIN);
  });
});

describe('shapeOf', () => {
  it('skips _-prefixed keys and orders by Object.keys', () => {
    const shape = shapeOf({a: signal(1), b: 2, _hidden: 99, c: () => {}});
    expect(shape.keys).toEqual(['a', 'b', 'c']);
    expect(shape.kinds).toEqual([SLOT_SIGNAL, SLOT_PLAIN, SLOT_HANDLE]);
  });
});

describe('shapeSignature', () => {
  it('gives distinct signatures for distinct shapes', () => {
    const a = shapeOf({x: signal(0)});
    const b = shapeOf({x: 1});
    expect(shapeSignature(a)).not.toBe(shapeSignature(b));
  });

  it('is stable for identical shapes', () => {
    const a = shapeOf({x: signal(0), y: 'hi'});
    const b = shapeOf({x: signal(1), y: 'yo'});
    expect(shapeSignature(a)).toBe(shapeSignature(b));
  });
});
