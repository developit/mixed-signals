import {afterEach, describe, expect, it, vi} from 'vitest';
import type {WireContext} from '../../client/reflection.ts';
import {ClientReflection} from '../../client/reflection.ts';
import type {RPCClient} from '../../client/rpc.ts';
import {
  UNWATCH_SIGNALS_METHOD,
  WATCH_SIGNALS_METHOD,
} from '../../shared/protocol.ts';
import {ReflectedCounter} from '../helpers.ts';

class TaskModel {
  ctx: WireContext;
  data: Record<string, unknown>;
  constructor(ctx: WireContext, data: Record<string, unknown>) {
    this.ctx = ctx;
    this.data = data;
  }
}

function setup() {
  const notify = vi.fn();
  const rpc = {
    notify,
    call: vi.fn(async () => undefined),
  } satisfies Partial<RPCClient> as unknown as RPCClient;
  const ctx = {rpc};
  const reflection = new ClientReflection(rpc);
  return {reflection, notify, rpc, ctx};
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ClientReflection', () => {
  describe('getOrCreateSignal', () => {
    it('creates signal with initial value', () => {
      const {reflection} = setup();
      const sig = reflection.getOrCreateSignal(1, 42);
      expect(sig.peek()).toBe(42);
    });

    it('returns cached signal for same id', () => {
      const {reflection} = setup();
      const sig1 = reflection.getOrCreateSignal(1, 42);
      const sig2 = reflection.getOrCreateSignal(1, 99);
      expect(sig1).toBe(sig2);
      expect(sig2.peek()).toBe(42);
    });

    it('different ids get different signals', () => {
      const {reflection} = setup();
      const sig1 = reflection.getOrCreateSignal(1, 'a');
      const sig2 = reflection.getOrCreateSignal(2, 'b');
      expect(sig1).not.toBe(sig2);
      expect(sig1.peek()).toBe('a');
      expect(sig2.peek()).toBe('b');
    });

    it('stores signal cache entries behind dereferenceable refs', () => {
      const {reflection} = setup();
      const sig = reflection.getOrCreateSignal(1, 'a');
      const cachedRef = (reflection as any).signals.get(1);

      expect(cachedRef).not.toBe(sig);
      expect(cachedRef.deref()).toBe(sig);
    });

    it('sweeps collected signal cache entries', () => {
      const {reflection} = setup();
      const sig = reflection.getOrCreateSignal(1, 'live');
      (reflection as any).signals.set(2, {deref: () => undefined});

      reflection.sweepCollectedEntries();

      expect((reflection as any).signals.get(1).deref()).toBe(sig);
      expect((reflection as any).signals.has(2)).toBe(false);
      expect(reflection.getOrCreateSignal(2, 'new').peek()).toBe('new');
    });
  });

  describe('watch/unwatch batching', () => {
    it('reuses signals by wire id', () => {
      const {reflection} = setup();
      const sig1 = reflection.getOrCreateSignal(1, 'first');
      const sig2 = reflection.getOrCreateSignal(1, 'ignored');
      expect(sig1).toBe(sig2);
    });

    it('batches watch and unwatch notifications', () => {
      vi.useFakeTimers();
      const {reflection, notify} = setup();

      const sig1 = reflection.getOrCreateSignal(1, 'a');
      const sig2 = reflection.getOrCreateSignal(2, 'b');

      const stop1 = sig1.subscribe(() => {});
      const stop2 = sig2.subscribe(() => {});

      vi.advanceTimersByTime(10);

      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(WATCH_SIGNALS_METHOD, [1, 2]);

      notify.mockClear();

      stop1();
      stop2();

      vi.advanceTimersByTime(10);

      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(UNWATCH_SIGNALS_METHOD, [1, 2]);
    });

    it('cancels a pending unwatch when a signal remounts quickly', () => {
      vi.useFakeTimers();
      const {reflection, notify} = setup();

      const sig = reflection.getOrCreateSignal(1, 'val');

      const stop = sig.subscribe(() => {});
      vi.advanceTimersByTime(10);

      expect(notify).toHaveBeenCalledWith(WATCH_SIGNALS_METHOD, [1]);
      notify.mockClear();

      stop();
      vi.advanceTimersByTime(5);

      sig.subscribe(() => {});
      vi.advanceTimersByTime(20);

      expect(notify).not.toHaveBeenCalledWith(
        UNWATCH_SIGNALS_METHOD,
        expect.anything(),
      );
    });

    it('schedules @W notification when signal is watched', () => {
      vi.useFakeTimers();
      const {reflection, notify} = setup();

      const sig = reflection.getOrCreateSignal(1, 'val');
      sig.subscribe(() => {});

      vi.advanceTimersByTime(10);

      expect(notify).toHaveBeenCalledWith(WATCH_SIGNALS_METHOD, [1]);
    });

    it('batches multiple watch requests into single message', () => {
      vi.useFakeTimers();
      const {reflection, notify} = setup();

      const sig1 = reflection.getOrCreateSignal(1, 'a');
      const sig2 = reflection.getOrCreateSignal(2, 'b');
      const sig3 = reflection.getOrCreateSignal(3, 'c');

      sig1.subscribe(() => {});
      sig2.subscribe(() => {});
      sig3.subscribe(() => {});

      vi.advanceTimersByTime(10);

      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(WATCH_SIGNALS_METHOD, [1, 2, 3]);
    });

    it('schedules @U after unwatch debounce timeout', () => {
      vi.useFakeTimers();
      const {reflection, notify} = setup();

      const sig = reflection.getOrCreateSignal(1, 'val');
      const stop = sig.subscribe(() => {});

      vi.advanceTimersByTime(10);
      expect(notify).toHaveBeenCalledWith(WATCH_SIGNALS_METHOD, [1]);
      notify.mockClear();

      stop();
      vi.advanceTimersByTime(10);

      expect(notify).toHaveBeenCalledWith(UNWATCH_SIGNALS_METHOD, [1]);
    });

    it('cancels a pending watch when a signal unmounts before the flush', () => {
      vi.useFakeTimers();
      const {reflection, notify} = setup();

      const sig = reflection.getOrCreateSignal(1, 'val');
      const stop = sig.subscribe(() => {});
      stop();

      vi.advanceTimersByTime(10);

      expect(notify).not.toHaveBeenCalled();
    });

    it('keeps watch and unwatch batches mutually exclusive', () => {
      vi.useFakeTimers();
      const {reflection, notify} = setup();

      const sig = reflection.getOrCreateSignal(1, 'val');
      const stop = sig.subscribe(() => {});
      vi.advanceTimersByTime(10);
      expect(notify).toHaveBeenCalledWith(WATCH_SIGNALS_METHOD, [1]);
      notify.mockClear();

      stop();
      sig.subscribe(() => {});

      vi.advanceTimersByTime(10);

      expect(notify).not.toHaveBeenCalled();
    });

    it('flushes later transitions in the active global window', () => {
      vi.useFakeTimers();
      const {reflection, notify} = setup();

      const canceled = reflection.getOrCreateSignal(1, 'a');
      const stop = canceled.subscribe(() => {});
      stop();

      vi.advanceTimersByTime(9);

      const watched = reflection.getOrCreateSignal(2, 'b');
      watched.subscribe(() => {});

      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(1);

      expect(notify).toHaveBeenCalledWith(WATCH_SIGNALS_METHOD, [2]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('uses one global watch timer for many signal transitions', () => {
      vi.useFakeTimers();
      const first = setup();
      const second = setup();

      const sig1 = first.reflection.getOrCreateSignal(1, 'a');
      const sig2 = first.reflection.getOrCreateSignal(2, 'b');
      const sig3 = second.reflection.getOrCreateSignal(3, 'c');

      const stop1 = sig1.subscribe(() => {});
      const stop2 = sig2.subscribe(() => {});
      const stop3 = sig3.subscribe(() => {});

      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(10);
      stop1();
      stop2();
      stop3();

      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(10);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('createModelFacade', () => {
    it('creates model facades and validates markers', () => {
      const {reflection} = setup();
      reflection.registerModel('Task', TaskModel);

      const facade = reflection.createModelFacade({
        '@M': 'Task#42',
        title: 'Ship',
      });

      expect(facade).toBeInstanceOf(TaskModel);
      expect(facade.data['@wireId']).toBe('42');

      // Missing @M throws
      expect(() => reflection.createModelFacade({})).toThrow(
        'Model missing @M field',
      );

      // Unknown type throws
      expect(() => reflection.createModelFacade({'@M': 'Unknown#1'})).toThrow(
        'Unknown model type',
      );
    });

    it('reuses cached facades for repeated model markers', () => {
      const {reflection} = setup();
      reflection.registerModel('Task', TaskModel);

      const facade1 = reflection.createModelFacade({
        '@M': 'Task#42',
        title: 'Ship',
      });
      const facade2 = reflection.createModelFacade({
        '@M': 'Task#42',
        title: 'Ship again',
      });

      expect(facade1).toBe(facade2);
    });

    it('creates facade from serialized data with @M marker', () => {
      const {reflection} = setup();
      reflection.registerModel('Counter', ReflectedCounter);

      const sig = reflection.getOrCreateSignal(10, 0);

      const facade = reflection.createModelFacade({
        '@M': 'Counter#abc',
        count: sig,
      });

      expect(facade.id.peek()).toBe('abc');
    });

    it('throws on missing @M field', () => {
      const {reflection} = setup();
      expect(() => reflection.createModelFacade({})).toThrow(
        'Model missing @M field',
      );
    });

    it('throws on unknown model type', () => {
      const {reflection} = setup();
      expect(() =>
        reflection.createModelFacade({'@M': 'Nonexistent#1'}),
      ).toThrow('Unknown model type');
    });

    it('caches facade - same @M returns same object', () => {
      const {reflection} = setup();
      reflection.registerModel('Task', TaskModel);

      const a = reflection.createModelFacade({'@M': 'Task#7'});
      const b = reflection.createModelFacade({'@M': 'Task#7'});
      expect(a).toBe(b);
    });

    it('different @M markers get different facades', () => {
      const {reflection} = setup();
      reflection.registerModel('Counter', ReflectedCounter);

      const a = reflection.createModelFacade({'@M': 'Counter#1'});
      const b = reflection.createModelFacade({'@M': 'Counter#2'});
      expect(a).not.toBe(b);
    });

    it('stores model facades and their signals behind dereferenceable refs', () => {
      const {reflection} = setup();
      reflection.registerModel('Task', TaskModel);

      const title = reflection.getOrCreateSignal(1, 'Ship');
      const facade = reflection.createModelFacade({
        '@M': 'Task#1',
        title,
      });

      const modelRef = (reflection as any).models.get('Task#1');
      const [signalRef] = (reflection as any).modelSignals.get('Task#1');

      expect(modelRef).not.toBe(facade);
      expect(modelRef.deref()).toBe(facade);
      expect(signalRef).not.toBe(title);
      expect(signalRef.deref()).toBe(title);
    });

    it('sweeps collected model facades and signal indexes', () => {
      const {reflection} = setup();
      (reflection as any).models.set('Task#dead', {deref: () => undefined});
      (reflection as any).modelSignals.set(
        'Task#dead',
        new Set([{deref: () => undefined}]),
      );
      (reflection as any).staleModelMarkers.add('Task#dead');
      (reflection as any).refreshingModelMarkers.add('Task#dead');

      reflection.sweepCollectedEntries();

      expect((reflection as any).models.has('Task#dead')).toBe(false);
      expect((reflection as any).modelSignals.has('Task#dead')).toBe(false);
      expect((reflection as any).staleModelMarkers.has('Task#dead')).toBe(
        false,
      );
      expect((reflection as any).refreshingModelMarkers.has('Task#dead')).toBe(
        false,
      );
    });

    it('refreshes stale models for watched signals without full-cache sweeping', () => {
      vi.useFakeTimers();
      const {reflection, rpc} = setup();
      reflection.registerModel('Counter', ReflectedCounter);
      const count = reflection.getOrCreateSignal(1, 0);
      reflection.createModelFacade({'@M': 'Counter#abc', count});
      (reflection as any).staleModelMarkers.add('Counter#abc');
      const sweep = vi.spyOn(reflection, 'sweepCollectedEntries');

      count.subscribe(() => undefined);

      expect(sweep).not.toHaveBeenCalled();
      expect(rpc.call).toHaveBeenCalledWith('@M', ['Counter#abc']);
      reflection.reset();
    });
  });

  describe('reset', () => {
    it('clears signals so new ones are created fresh', () => {
      const {reflection} = setup();
      const sig1 = reflection.getOrCreateSignal(1, 'old');
      reflection.reset();
      const sig2 = reflection.getOrCreateSignal(1, 'new');
      expect(sig2).not.toBe(sig1);
      expect(sig2.peek()).toBe('new');
    });

    it('clears model facade cache', () => {
      const {reflection} = setup();
      reflection.registerModel('Task', TaskModel);

      const facade1 = reflection.createModelFacade({'@M': 'Task#1', x: 1});
      reflection.reset();
      const facade2 = reflection.createModelFacade({'@M': 'Task#1', x: 2});
      expect(facade2).not.toBe(facade1);
    });

    it('preserves model registry', () => {
      const {reflection} = setup();
      reflection.registerModel('Task', TaskModel);
      reflection.reset();
      // Should still be able to create facades for registered types
      const facade = reflection.createModelFacade({'@M': 'Task#1'});
      expect(facade).toBeInstanceOf(TaskModel);
    });

    it('cancels pending watch/unwatch timers', () => {
      vi.useFakeTimers();
      const {reflection, notify} = setup();

      const sig = reflection.getOrCreateSignal(1, 'val');
      sig.subscribe(() => {});
      // Watch is pending (1ms timer not yet fired)

      reflection.reset();

      vi.advanceTimersByTime(10);
      // The pending watch timer should have been cancelled
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('handleUpdate', () => {
    it('applies append, merge, splice, and replacement updates', () => {
      const {reflection} = setup();

      // Array append
      const arrSig = reflection.getOrCreateSignal(1, [1, 2]);
      reflection.handleUpdate(1, [3, 4], 'append');
      expect(arrSig.peek()).toEqual([1, 2, 3, 4]);

      // String append
      const strSig = reflection.getOrCreateSignal(2, 'hello');
      reflection.handleUpdate(2, ' world', 'append');
      expect(strSig.peek()).toBe('hello world');

      // Object merge
      const objSig = reflection.getOrCreateSignal(3, {a: 1, b: 2});
      reflection.handleUpdate(3, {b: 3, c: 4}, 'merge');
      expect(objSig.peek()).toEqual({a: 1, b: 3, c: 4});

      // Splice
      const spliceSig = reflection.getOrCreateSignal(4, [1, 2, 3, 4, 5]);
      reflection.handleUpdate(
        4,
        {start: 1, deleteCount: 2, items: [20, 30]},
        'splice',
      );
      expect(spliceSig.peek()).toEqual([1, 20, 30, 4, 5]);

      // Full replacement (no mode)
      const replaceSig = reflection.getOrCreateSignal(5, 'old');
      reflection.handleUpdate(5, 'new');
      expect(replaceSig.peek()).toBe('new');
    });

    it('full replace: sets signal value directly', () => {
      const {reflection} = setup();
      const sig = reflection.getOrCreateSignal(1, 'before');
      reflection.handleUpdate(1, 'after');
      expect(sig.peek()).toBe('after');
    });

    it('append array: concatenates new items', () => {
      const {reflection} = setup();
      const sig = reflection.getOrCreateSignal(1, ['a', 'b']);
      reflection.handleUpdate(1, ['c'], 'append');
      expect(sig.peek()).toEqual(['a', 'b', 'c']);
    });

    it('append string: concatenates new string', () => {
      const {reflection} = setup();
      const sig = reflection.getOrCreateSignal(1, 'foo');
      reflection.handleUpdate(1, 'bar', 'append');
      expect(sig.peek()).toBe('foobar');
    });

    it('merge object: spreads new properties', () => {
      const {reflection} = setup();
      const sig = reflection.getOrCreateSignal(1, {x: 1, y: 2});
      reflection.handleUpdate(1, {y: 99, z: 3}, 'merge');
      expect(sig.peek()).toEqual({x: 1, y: 99, z: 3});
    });

    it('splice array: applies splice operation', () => {
      const {reflection} = setup();
      const sig = reflection.getOrCreateSignal(1, [10, 20, 30, 40]);
      reflection.handleUpdate(
        1,
        {start: 1, deleteCount: 1, items: [25]},
        'splice',
      );
      expect(sig.peek()).toEqual([10, 25, 30, 40]);
    });

    it('no-op for unknown signal id', () => {
      const {reflection} = setup();
      // Should not throw
      reflection.handleUpdate(999, 'value');
    });

    it('unknown mode falls back to full replace', () => {
      const {reflection} = setup();
      const sig = reflection.getOrCreateSignal(1, 'original');
      reflection.handleUpdate(1, 'replaced', 'unknownMode');
      expect(sig.peek()).toBe('replaced');
    });
  });
});
