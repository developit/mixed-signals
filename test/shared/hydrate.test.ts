import {describe, expect, it} from 'vitest';
import {Hydrator} from '../../shared/hydrate.ts';

function makeHydrator() {
  const calls: Array<[string, readonly unknown[]]> = [];
  const env = {
    call: async (method: string, args: readonly unknown[]) => {
      calls.push([method, args]);
      return null;
    },
    scheduleRelease: () => {},
    scheduleWatch: () => {},
    scheduleUnwatch: () => {},
    registerPendingPromise: () => {},
  };
  return {hydrator: new Hydrator(env), calls};
}

describe('Hydrator: ensureClass error surfaces', () => {
  it('throws a clear error for a bare numeric class ref with no known def', () => {
    const {hydrator} = makeHydrator();
    expect(() => hydrator.hydrate({'@H': 'o1', c: 999, d: []})).toThrow(
      /Unknown class id 999/,
    );
  });

  it('throws when the c field is neither string nor number', () => {
    const {hydrator} = makeHydrator();
    expect(() => hydrator.hydrate({'@H': 'o1', c: null, d: []})).toThrow(
      /Invalid class marker/,
    );
  });

  it('throws when the string form has a non-numeric id prefix', () => {
    const {hydrator} = makeHydrator();
    expect(() =>
      hydrator.hydrate({'@H': 'o1', c: 'abc#Counter', p: 'x', d: []}),
    ).toThrow(/id is not numeric/);
  });

  it('hydrates a class instance from a well-formed first-emission marker', () => {
    const {hydrator} = makeHydrator();
    const proxy = hydrator.hydrate({
      '@H': 'o1',
      c: '1#Counter',
      p: 'count',
      d: [42],
    });
    expect(proxy.count).toBe(42);
    const Counter = hydrator.classOf('Counter');
    expect(Counter).toBeDefined();
    expect(proxy).toBeInstanceOf(Counter!);
  });

  it('hydrates an ad-hoc object (no c field) with a keyed d', () => {
    const {hydrator} = makeHydrator();
    const proxy = hydrator.hydrate({
      '@H': 'o1',
      d: {x: 1, y: 2},
    });
    expect(proxy.x).toBe(1);
    expect(proxy.y).toBe(2);
  });
});

describe('Hydrator: Proxy has trap is faithful', () => {
  it('returns true for real target keys and false for synthesized methods', () => {
    const {hydrator} = makeHydrator();
    const proxy = hydrator.hydrate({
      '@H': 'o1',
      c: '1#Thing',
      p: 'value',
      d: [5],
    });
    // Real keys are truly present:
    expect('value' in proxy).toBe(true);
    // Trap-dispatched methods are NOT reflected as membership \u2014 callers
    // should use `proxy.method?.(...)` instead of `'method' in proxy`.
    expect('somethingElse' in proxy).toBe(false);
    // But the method stub is still callable on access:
    expect(typeof proxy.somethingElse).toBe('function');
  });
});
