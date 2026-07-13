import {signal} from '@preact/signals-core';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {Instances} from '../../server/instances.ts';
import {Reflection} from '../../server/reflection.ts';
import {
  parseWireMessage,
  parseWireParams,
  SIGNAL_UPDATE_METHOD,
} from '../../shared/protocol.ts';
import {Counter} from '../helpers.ts';

type SentMessage = {clientId: string; message: string};

class FakeSender {
  sent: SentMessage[] = [];
  send(clientId: string, message: string) {
    this.sent.push({clientId, message});
  }
}

function parseUpdate(message: string): [number, unknown, string?] {
  const parsed = parseWireMessage(message);
  expect(parsed).toMatchObject({
    type: 'notification',
    method: SIGNAL_UPDATE_METHOD,
  });
  if (!parsed || parsed.type !== 'notification')
    throw new Error('Expected a signal update notification');
  return parseWireParams<[number, unknown, string?]>(parsed.payload);
}

function setupCounter(
  reflection: Reflection,
  instances: Instances,
  clientId?: string,
) {
  reflection.registerModel('Counter', Counter);
  const c = new Counter();
  instances.register('0', c);
  const serialized = reflection.serialize(c, clientId);
  const countId = serialized.count['@S'] as number;
  const nameId = serialized.name['@S'] as number;
  const itemsId = serialized.items['@S'] as number;
  const metaId = serialized.meta['@S'] as number;
  return {counter: c, serialized, countId, nameId, itemsId, metaId};
}

describe('Reflection', () => {
  let sender: FakeSender;
  let instances: Instances;
  let reflection: Reflection;

  beforeEach(() => {
    sender = new FakeSender();
    instances = new Instances();
    reflection = new Reflection(sender, instances);
  });

  describe('model registration', () => {
    it('registerModel + isModel recognizes instances', () => {
      reflection.registerModel('Counter', Counter);
      expect(reflection.isModel(new Counter())).toBe(true);
    });

    it('isModel returns false for plain objects, null, primitives', () => {
      reflection.registerModel('Counter', Counter);
      expect(reflection.isModel({})).toBe(false);
      expect(reflection.isModel(null)).toBe(false);
      expect(reflection.isModel(42)).toBe(false);
      expect(reflection.isModel('str')).toBe(false);
      expect(reflection.isModel(undefined)).toBe(false);
    });

    it('getModelType returns registered name', () => {
      reflection.registerModel('Counter', Counter);
      expect(reflection.getModelType(new Counter())).toBe('Counter');
    });

    it('getModelType returns undefined for unregistered', () => {
      expect(reflection.getModelType({})).toBeUndefined();
    });
  });

  describe('getInstanceId', () => {
    it('returns existing id from instances registry', () => {
      const c = new Counter();
      instances.register('42', c);
      reflection.registerModel('Counter', Counter);
      expect(reflection.getInstanceId(c)).toBe('42');
    });

    it('uses model id plain property', () => {
      const obj = {id: 'my-id'};
      expect(reflection.getInstanceId(obj)).toBe('my-id');
    });

    it('unwraps Signal id property via peek()', () => {
      const obj = {id: signal('sig-id')};
      expect(reflection.getInstanceId(obj)).toBe('sig-id');
    });

    it('auto-generates id for models without id', () => {
      const obj = {name: 'no-id'};
      const id = reflection.getInstanceId(obj);
      expect(typeof id).toBe('string');
    });

    it('auto-generated id is stable', () => {
      const obj = {name: 'no-id'};
      const id1 = reflection.getInstanceId(obj);
      const id2 = reflection.getInstanceId(obj);
      expect(id1).toBe(id2);
    });
  });

  describe('serialize', () => {
    it('serializes signals and models without leaking private or function props', () => {
      class Task {
        id = signal('42');
        name = signal('Ship it');
        extra = 'public';
        _secret = 'hidden';
        rename(next: string) {
          this.name.value = next;
        }
      }

      reflection.registerModel('Task', Task);
      const task = new Task();

      const result = reflection.serialize(
        {shared: signal(1), task},
        'client-1',
      );

      // shared signal
      expect(result.shared).toHaveProperty('@S');
      expect(result.shared.v).toBe(1);

      // task model
      expect(result.task['@M']).toBe('Task#42');
      expect(result.task.extra).toBe('public');
      expect(result.task.id).toHaveProperty('@S');
      expect(result.task.name).toHaveProperty('@S');
      expect(result.task._secret).toBeUndefined();
      expect(result.task.rename).toBeUndefined();

      // instance registered
      expect(instances.get('42')).toBe(task);

      // separate serializations are full snapshots; only a single serialization
      // pass deduplicates repeated model references.
      const again = reflection.serialize(task, 'client-1');
      expect(again['@M']).toBe('Task#42');
      expect(again.name).toHaveProperty('@S');

      // full serialization for different client
      const other = reflection.serialize(task, 'client-2');
      expect(other['@M']).toBe('Task#42');
      expect(other.name).toHaveProperty('@S');
    });

    it('serializes model signals as {@S: id, v: value} markers', () => {
      const {serialized} = setupCounter(reflection, instances);
      expect(serialized.count).toHaveProperty('@S');
      expect(serialized.count.v).toBe(0);
    });

    it('assigns unique signal IDs', () => {
      const {countId, nameId, itemsId, metaId} = setupCounter(
        reflection,
        instances,
      );
      const ids = new Set([countId, nameId, itemsId, metaId]);
      expect(ids.size).toBe(4);
    });

    it('same signal gets same ID across serializations', () => {
      reflection.registerModel('Counter', Counter);
      const c = new Counter();
      instances.register('0', c);
      const first = reflection.serialize(c);
      const second = reflection.serialize(c);
      expect(first.count['@S']).toBe(second.count['@S']);
      expect(first.name['@S']).toBe(second.name['@S']);
    });

    it('registers a live signal with the finalizer only once', () => {
      const register = vi.fn();
      (reflection as any).signalFinalizer = {register};
      const value = signal('stable');

      reflection.serialize({value});
      reflection.serialize({value});

      expect(register).toHaveBeenCalledTimes(1);
    });

    it('does not subscribe or retain values until the client watches', () => {
      const clientId = 'client-1';
      const value = signal('initial');
      const serialized = reflection.serialize({value}, clientId);
      const signalId = serialized.value['@S'] as number;

      value.value = 'before-watch';

      expect((reflection as any).subscriptions.has(signalId)).toBe(false);
      expect((reflection as any).signalUnsubscribers.has(signalId)).toBe(false);
      expect(
        (reflection as any).lastSentValues.has(`${clientId}:${signalId}`),
      ).toBe(false);
      expect(sender.sent).toHaveLength(0);

      reflection.watch(clientId, signalId);

      expect(parseUpdate(sender.sent[0].message)).toEqual([
        signalId,
        'before-watch',
      ]);
      expect((reflection as any).signalUnsubscribers.has(signalId)).toBe(true);
    });

    it('sends an initial update when a newly watched value is undefined', () => {
      const clientId = 'client-1';
      const value = signal<string | undefined>('initial');
      const serialized = reflection.serialize({value}, clientId);
      const signalId = serialized.value['@S'] as number;
      value.value = undefined;

      reflection.watch(clientId, signalId);

      expect(sender.sent).toHaveLength(1);
      expect(parseUpdate(sender.sent[0].message)).toEqual([signalId, null]);
    });

    it('serializes model with @M marker and signal props', () => {
      const {serialized} = setupCounter(reflection, instances);
      expect(serialized['@M']).toMatch(/^Counter#/);
      expect(serialized.count).toHaveProperty('@S');
      expect(serialized.name).toHaveProperty('@S');
    });

    it('skips properties starting with _', () => {
      const {serialized} = setupCounter(reflection, instances);
      expect(serialized._internal).toBeUndefined();
    });

    it('skips function properties on models', () => {
      const {serialized} = setupCounter(reflection, instances);
      expect(serialized.increment).toBeUndefined();
      expect(serialized.add).toBeUndefined();
      expect(serialized.rename).toBeUndefined();
    });

    it('deduplicates repeated model references during one serialization pass', () => {
      reflection.registerModel('Counter', Counter);
      const c = new Counter();
      instances.register('0', c);
      const serialized = reflection.serialize({first: c, second: c}, 'clientA');
      expect(serialized.first.count).toHaveProperty('@S');
      expect(serialized.second).toEqual({'@M': 'Counter#0'});
    });

    it('different clients get full serialization independently', () => {
      reflection.registerModel('Counter', Counter);
      const c = new Counter();
      instances.register('0', c);
      const forA = reflection.serialize(c, 'clientA');
      const forB = reflection.serialize(c, 'clientB');
      expect(forA.count).toHaveProperty('@S');
      expect(forB.count).toHaveProperty('@S');
    });

    it('auto-registers model instance', () => {
      class AutoCounter {
        id = 'auto-99';
        count = signal(0);
      }
      reflection.registerModel('Counter', AutoCounter);
      const c = new AutoCounter();
      const serialized = reflection.serialize(c);
      expect(serialized['@M']).toBe('Counter#auto-99');
      expect(instances.get('auto-99')).toBe(c);
    });

    it('stores serialized signals behind dereferenceable refs', () => {
      const {counter, countId} = setupCounter(reflection, instances);
      const cachedRef = (reflection as any).signals.get(countId);

      expect(cachedRef).not.toBe(counter.count);
      expect(cachedRef.deref()).toBe(counter.count);
    });

    it('sweeps collected signal cache entries', () => {
      const {countId} = setupCounter(reflection, instances);
      (reflection as any).signals.set(99, {deref: () => undefined});

      reflection.sweepCollectedSignals();

      expect((reflection as any).signals.has(countId)).toBe(true);
      expect((reflection as any).signals.has(99)).toBe(false);
    });

    it('handles null values', () => {
      expect(reflection.serialize(null)).toBeNull();
    });

    it('serializes plain values as-is', () => {
      expect(reflection.serialize(42)).toBe(42);
      expect(reflection.serialize('hello')).toBe('hello');
      expect(reflection.serialize([1, 2])).toEqual([1, 2]);
    });

    it('skips rpc, reflection, and instances references', () => {
      reflection.registerModel('Counter', Counter);
      const c = new Counter();
      (c as any).rpc = sender;
      (c as any).reflection = reflection;
      (c as any).instances = instances;
      instances.register('0', c);
      const serialized = reflection.serialize(c);
      expect(serialized.rpc).toBeUndefined();
      expect(serialized.reflection).toBeUndefined();
      expect(serialized.instances).toBeUndefined();
    });
  });

  describe('watch / unwatch', () => {
    it('watch subscribes client to signal updates', () => {
      const clientId = 'c1';
      const {counter, countId} = setupCounter(reflection, instances, clientId);
      reflection.watch(clientId, countId);
      counter.count.value = 5;
      const relevant = sender.sent.filter((m) => m.clientId === clientId);
      expect(relevant.length).toBeGreaterThan(0);
      const [id, value] = parseUpdate(relevant[relevant.length - 1].message);
      expect(id).toBe(countId);
      expect(value).toBe(5);
    });

    it('unwatch removes client from signal subscribers', () => {
      const clientId = 'c1';
      const {counter, countId} = setupCounter(reflection, instances, clientId);
      reflection.watch(clientId, countId);
      counter.count.value = 1;
      reflection.unwatch(clientId, countId);
      sender.sent.length = 0;
      counter.count.value = 2;
      const relevant = sender.sent.filter((m) => m.clientId === clientId);
      expect(relevant.length).toBe(0);
    });

    it('multiple clients receive independent updates', () => {
      const {counter, countId} = setupCounter(reflection, instances, 'c1');
      reflection.serialize(counter, 'c2');
      reflection.watch('c1', countId);
      reflection.watch('c2', countId);
      counter.count.value = 10;
      const c1msgs = sender.sent.filter((m) => m.clientId === 'c1');
      const c2msgs = sender.sent.filter((m) => m.clientId === 'c2');
      expect(c1msgs.length).toBeGreaterThan(0);
      expect(c2msgs.length).toBeGreaterThan(0);
    });

    it('catches up a new watcher without duplicating existing watchers', () => {
      const {counter, countId} = setupCounter(reflection, instances, 'c1');
      reflection.serialize(counter, 'c2');
      reflection.watch('c1', countId);
      counter.count.value = 5;
      sender.sent.length = 0;

      reflection.watch('c2', countId);

      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0].clientId).toBe('c2');
      expect(parseUpdate(sender.sent[0].message)).toEqual([countId, 5]);
    });
  });

  describe('delta compression', () => {
    it('sends append deltas for immutable array pushes', () => {
      const arr = signal([1]);
      const wrapper = {arr};
      const serialized = reflection.serialize(wrapper, 'c1');
      const signalId = serialized.arr['@S'] as number;
      reflection.watch('c1', signalId);
      arr.value = [1, 2, 3];
      const relevant = sender.sent.filter((m) => m.clientId === 'c1');
      expect(relevant.length).toBeGreaterThan(0);
      const [id, value, mode] = parseUpdate(
        relevant[relevant.length - 1].message,
      );
      expect(id).toBe(signalId);
      expect(value).toEqual([2, 3]);
      expect(mode).toBe('append');
    });

    it('sends merge deltas for changed object keys', () => {
      const obj = signal({done: false, title: 'Ship'});
      const wrapper = {obj};
      const serialized = reflection.serialize(wrapper, 'c1');
      const signalId = serialized.obj['@S'] as number;
      reflection.watch('c1', signalId);
      obj.value = {done: true, title: 'Ship'};
      const relevant = sender.sent.filter((m) => m.clientId === 'c1');
      expect(relevant.length).toBeGreaterThan(0);
      const [id, value, mode] = parseUpdate(
        relevant[relevant.length - 1].message,
      );
      expect(id).toBe(signalId);
      expect(value).toEqual({done: true});
      expect(mode).toBe('merge');
    });

    it('falls back to full replacements when no delta mode applies', () => {
      const str = signal('before');
      const wrapper = {str};
      const serialized = reflection.serialize(wrapper, 'c1');
      const signalId = serialized.str['@S'] as number;
      reflection.watch('c1', signalId);
      str.value = 'after';
      const relevant = sender.sent.filter((m) => m.clientId === 'c1');
      expect(relevant.length).toBeGreaterThan(0);
      const [id, value, mode] = parseUpdate(
        relevant[relevant.length - 1].message,
      );
      expect(id).toBe(signalId);
      expect(value).toBe('after');
      expect(mode).toBeUndefined();
    });

    it('skips clients where value has not changed', () => {
      const clientId = 'c1';
      const {counter, countId} = setupCounter(reflection, instances, clientId);
      reflection.watch(clientId, countId);
      counter.count.value = 5;
      const countBefore = sender.sent.length;
      counter.count.value = 5;
      expect(sender.sent.length).toBe(countBefore);
    });

    it('sends delta for array append', () => {
      const clientId = 'c1';
      const {counter, itemsId} = setupCounter(reflection, instances, clientId);
      reflection.watch(clientId, itemsId);
      counter.items.value = ['a', 'b', 'c'];
      sender.sent.length = 0;
      counter.items.value = ['a', 'b', 'c', 'd', 'e'];
      const relevant = sender.sent.filter((m) => m.clientId === clientId);
      expect(relevant.length).toBeGreaterThan(0);
      const [id, value, mode] = parseUpdate(
        relevant[relevant.length - 1].message,
      );
      expect(id).toBe(itemsId);
      expect(value).toEqual(['d', 'e']);
      expect(mode).toBe('append');
    });

    it('sends full replacement for non-append array change', () => {
      const clientId = 'c1';
      const {counter, itemsId} = setupCounter(reflection, instances, clientId);
      reflection.watch(clientId, itemsId);
      counter.items.value = ['a', 'b', 'c'];
      sender.sent.length = 0;
      counter.items.value = ['x', 'y'];
      const relevant = sender.sent.filter((m) => m.clientId === clientId);
      expect(relevant.length).toBeGreaterThan(0);
      const last = relevant[relevant.length - 1].message;
      expect(last).not.toContain('"append"');
    });

    it('sends delta for object merge', () => {
      const clientId = 'c1';
      const {counter, metaId} = setupCounter(reflection, instances, clientId);
      reflection.watch(clientId, metaId);
      counter.meta.value = {version: 2};
      const relevant = sender.sent.filter((m) => m.clientId === clientId);
      expect(relevant.length).toBeGreaterThan(0);
      const [id, value, mode] = parseUpdate(
        relevant[relevant.length - 1].message,
      );
      expect(id).toBe(metaId);
      expect(value).toEqual({version: 2});
      expect(mode).toBe('merge');
    });

    it('sends delta for string append', () => {
      const clientId = 'c1';
      const {counter, nameId} = setupCounter(reflection, instances, clientId);
      reflection.watch(clientId, nameId);
      counter.name.value = 'default-extended';
      const relevant = sender.sent.filter((m) => m.clientId === clientId);
      expect(relevant.length).toBeGreaterThan(0);
      const [id, value, mode] = parseUpdate(
        relevant[relevant.length - 1].message,
      );
      expect(id).toBe(nameId);
      expect(value).toBe('-extended');
      expect(mode).toBe('append');
    });

    it('sends full replacement when no delta applies', () => {
      const clientId = 'c1';
      const {counter, nameId} = setupCounter(reflection, instances, clientId);
      reflection.watch(clientId, nameId);
      counter.name.value = 'completely different';
      const relevant = sender.sent.filter((m) => m.clientId === clientId);
      expect(relevant.length).toBeGreaterThan(0);
      const last = relevant[relevant.length - 1].message;
      expect(last).not.toContain('"append"');
      expect(last).not.toContain('"merge"');
    });

    it('serializes nested model references in method results', () => {
      class ChildCounter {
        id = 'c1';
        name = signal('child-counter');
        count = signal(0);
      }
      reflection.registerModel('Counter', ChildCounter);
      const child = new ChildCounter();
      const wrapper = {child};
      const serialized = reflection.serialize(wrapper);
      expect(serialized.child['@M']).toBe('Counter#c1');
      expect(serialized.child.name.v).toBe('child-counter');
    });
  });

  describe('removeClient', () => {
    it('stops sending updates after removing a client', () => {
      const s = signal(1);
      const wrapper = {s};
      const serialized = reflection.serialize(wrapper, 'client-1');
      const signalId = serialized.s['@S'] as number;
      reflection.watch('client-1', signalId);
      sender.sent.length = 0;
      reflection.removeClient('client-1');
      s.value = 99;
      expect(sender.sent.length).toBe(0);
    });

    it('removes client from all subscriptions', () => {
      const clientId = 'c1';
      const {counter, countId, nameId} = setupCounter(
        reflection,
        instances,
        clientId,
      );
      reflection.watch(clientId, countId);
      reflection.watch(clientId, nameId);
      sender.sent.length = 0;
      reflection.removeClient(clientId);
      counter.count.value = 99;
      counter.name.value = 'gone';
      const relevant = sender.sent.filter((m) => m.clientId === clientId);
      expect(relevant.length).toBe(0);
    });

    it('clears last sent values when a client unwatches a signal', () => {
      const clientId = 'clientA';
      const {countId} = setupCounter(reflection, instances, clientId);
      expect(
        (reflection as any).lastSentValues.has(`${clientId}:${countId}`),
      ).toBe(false);

      reflection.watch(clientId, countId);
      expect(
        (reflection as any).lastSentValues.has(`${clientId}:${countId}`),
      ).toBe(true);

      reflection.unwatch(clientId, countId);

      expect(
        (reflection as any).lastSentValues.has(`${clientId}:${countId}`),
      ).toBe(false);
    });
  });
});
