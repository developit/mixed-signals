import {describe, expect, it} from 'vitest';
import {SLOT_OTHER, SLOT_SIGNAL, shapeSignature} from '../../shared/shapes.ts';

describe('shapeSignature', () => {
  it('gives distinct signatures for distinct shapes', () => {
    const a = {keys: ['x'], kinds: [SLOT_SIGNAL]};
    const b = {keys: ['x'], kinds: [SLOT_OTHER]};
    expect(shapeSignature(a)).not.toBe(shapeSignature(b));
  });

  it('is stable for identical shapes', () => {
    const a = {keys: ['x', 'y'], kinds: [SLOT_SIGNAL, SLOT_OTHER]};
    const b = {keys: ['x', 'y'], kinds: [SLOT_SIGNAL, SLOT_OTHER]};
    expect(shapeSignature(a)).toBe(shapeSignature(b));
  });

  it('encodes key order', () => {
    const a = {keys: ['x', 'y'], kinds: [SLOT_SIGNAL, SLOT_OTHER]};
    const b = {keys: ['y', 'x'], kinds: [SLOT_OTHER, SLOT_SIGNAL]};
    expect(shapeSignature(a)).not.toBe(shapeSignature(b));
  });
});
