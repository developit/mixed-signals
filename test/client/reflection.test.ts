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
    syncSignalIdentity: vi.fn((_previous, next) => next),
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

      vi.advanceTimersByTime(999);
      expect(notify).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
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
      vi.advanceTimersByTime(999);

      sig.subscribe(() => {});
      vi.advanceTimersByTime(1000);

      expect(notify).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('suppresses wire traffic across repeated short unwatch cycles', () => {
      vi.useFakeTimers();
      const {reflection, notify} = setup();
      const sig = reflection.getOrCreateSignal(1, 'val');
      let stop = sig.subscribe(() => {});

      vi.advanceTimersByTime(10);
      expect(notify).toHaveBeenCalledWith(WATCH_SIGNALS_METHOD, [1]);
      notify.mockClear();

      for (let cycle = 0; cycle < 3; cycle++) {
        stop();
        vi.advanceTimersByTime(250);
        stop = sig.subscribe(() => {});
      }

      vi.advanceTimersByTime(1000);
      expect(notify).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
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

    it('schedules @U after the longer global unwatch window', () => {
      vi.useFakeTimers();
      const {reflection, notify} = setup();

      const sig = reflection.getOrCreateSignal(1, 'val');
      const stop = sig.subscribe(() => {});

      vi.advanceTimersByTime(10);
      expect(notify).toHaveBeenCalledWith(WATCH_SIGNALS_METHOD, [1]);
      notify.mockClear();

      stop();
      vi.advanceTimersByTime(999);
      expect(notify).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(notify).toHaveBeenCalledWith(UNWATCH_SIGNALS_METHOD, [1]);
    });

    it('flushes watches promptly while an unwatch is pending', () => {
      vi.useFakeTimers();
      const {reflection, notify} = setup();

      const first = reflection.getOrCreateSignal(1, 'a');
      const second = reflection.getOrCreateSignal(2, 'b');
      const stopFirst = first.subscribe(() => {});

      vi.advanceTimersByTime(10);
      notify.mockClear();

      stopFirst();
      vi.advanceTimersByTime(500);
      second.subscribe(() => {});
      expect(vi.getTimerCount()).toBe(2);

      vi.advanceTimersByTime(10);

      expect(vi.getTimerCount()).toBe(1);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(WATCH_SIGNALS_METHOD, [2]);
      expect(notify).not.toHaveBeenCalledWith(
        UNWATCH_SIGNALS_METHOD,
        expect.anything(),
      );

      vi.advanceTimersByTime(490);
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

      vi.advanceTimersByTime(1000);

      expect(notify).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
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

    it('uses one global timer per direction for many signal transitions', () => {
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

      vi.advanceTimersByTime(1000);

      expect(first.notify).toHaveBeenCalledWith(UNWATCH_SIGNALS_METHOD, [1, 2]);
      expect(second.notify).toHaveBeenCalledWith(UNWATCH_SIGNALS_METHOD, [3]);
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

      // Unknown types are reflected automatically.
      expect(() =>
        reflection.createModelFacade({'@M': 'Unknown#1'}),
      ).not.toThrow();
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

    it('exposes nested model facades as properties on proxy facades', () => {
      const {reflection} = setup();
      const branch = reflection.getOrCreateSignal(5, 'main');
      const vcs = reflection.createModelFacade({'@M': 'Vcs#t1:vcs', branch});
      const status = reflection.getOrCreateSignal(6, 'running');

      const task = reflection.createModelFacade({'@M': 'Task#t1', status, vcs});

      expect(task.vcs).toBe(vcs);
      expect(task.vcs.branch.peek()).toBe('main');

      // A refresh replaces the nested facade rather than shadowing it.
      const nextVcs = reflection.createModelFacade({'@M': 'Vcs#t2:vcs'});
      reflection.createModelFacade({'@M': 'Task#t1', status, vcs: nextVcs});
      expect(task.vcs).toBe(nextVcs);
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

    it('creates proxy facades for unregistered model types', async () => {
      const {reflection, rpc} = setup();
      const title = reflection.getOrCreateSignal(99, 'Ship');

      const facade = reflection.createModelFacade({
        '@M': 'Nonexistent#1',
        id: 'server-id',
        plain: 'ignored',
        title,
      });

      expect(facade.id.peek()).toBe('1');
      expect(facade.title.peek()).toBe('Ship');
      expect(Object.hasOwn(facade, 'plain')).toBe(false);

      title.value = 'Shipped';
      expect(facade.title.peek()).toBe('Shipped');

      expect(facade.then).toBeUndefined();
      expect(Object.prototype.toString.call(facade)).toBe(
        '[object Nonexistent]',
      );
      expect(facade.rename).toBe(facade.rename);

      await facade.rename('next');
      expect(rpc.call).toHaveBeenCalledWith('1#rename', ['next']);

      await facade['0']('zero');
      expect(rpc.call).toHaveBeenCalledWith('1#0', ['zero']);
    });

    it('refreshes unregistered proxy facades in place', () => {
      const {reflection} = setup();
      const firstTitle = reflection.getOrCreateSignal(1, 'First');
      const facade = reflection.createModelFacade({
        '@M': 'Unknown#1',
        title: firstTitle,
      });
      const title = facade.title;

      const nextTitle = reflection.getOrCreateSignal(2, 'Second');
      const refreshed = reflection.createModelFacade({
        '@M': 'Unknown#1',
        title: nextTitle,
      });

      expect(refreshed).toBe(facade);
      expect(refreshed.title).toBe(title);
      expect(refreshed.title.peek()).toBe('Second');
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

    it('cancels pending watch and unwatch timers', () => {
      vi.useFakeTimers();
      const first = setup();
      const pendingWatch = first.reflection.getOrCreateSignal(1, 'watch');
      pendingWatch.subscribe(() => {});

      first.reflection.reset();
      vi.advanceTimersByTime(10);

      expect(first.notify).not.toHaveBeenCalled();

      const second = setup();
      const pendingUnwatch = second.reflection.getOrCreateSignal(2, 'unwatch');
      const stop = pendingUnwatch.subscribe(() => {});
      vi.advanceTimersByTime(10);
      second.notify.mockClear();
      stop();

      second.reflection.reset();
      vi.advanceTimersByTime(1000);

      expect(second.notify).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
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

  describe('reconcileRoot', () => {
    it('deletes keys absent from the next root and keeps the root identity', () => {
      const {reflection} = setup();
      const previousRoot = {a: 1, b: 2};
      const result = reflection.reconcileRoot(previousRoot, {a: 1});
      expect(result).toBe(previousRoot);
      expect(result).toEqual({a: 1});
      expect(Object.hasOwn(result, 'b')).toBe(false);
    });

    it('deletes removed keys that shadow Object.prototype properties', () => {
      const {reflection} = setup();
      const previousRoot = {version: 1, toString: 'user-data'};
      const result = reflection.reconcileRoot(previousRoot, {version: 2});
      expect(result).toBe(previousRoot);
      expect(result).toEqual({version: 2});
      expect(Object.hasOwn(result, 'toString')).toBe(false);
    });
  });
});
