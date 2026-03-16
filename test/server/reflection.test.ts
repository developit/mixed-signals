import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {signal} from '@preact/signals-core';
import {Instances} from '../../server/instances.ts';
import {Reflection} from '../../server/reflection.ts';
import {Counter} from '../helpers.ts';

describe('Reflection', () => {
  let instances: Instances;
  let sentMessages: {clientId: string; msg: string}[];
  let mockRpc: {send(clientId: string, msg: string): void};
  let reflection: Reflection;

  beforeEach(() => {
    instances = new Instances();
    sentMessages = [];
    mockRpc = {
      send(clientId: string, msg: string) {
        sentMessages.push({clientId, msg});
      },
    };
    reflection = new Reflection(mockRpc, instances);
  });

  // Helper: serialize a Counter model and return its signal IDs
  function setupCounter(clientId?: string) {
    reflection.registerModel('Counter', Counter);
    const c = new Counter();
    instances.register('0', c);
    const serialized = reflection.serialize(c, clientId);
    // Extract signal IDs from the serialized output
    const countId = serialized.count['@S'] as number;
    const nameId = serialized.name['@S'] as number;
    const itemsId = serialized.items['@S'] as number;
    const metaId = serialized.meta['@S'] as number;
    return {counter: c, serialized, countId, nameId, itemsId, metaId};
  }

  describe('model registration', () => {
    it('registerModel + isModel recognizes instances', () => {
      reflection.registerModel('Counter', Counter);
      const c = new Counter();
      assert.ok(reflection.isModel(c));
    });

    it('isModel returns false for plain objects, null, primitives', () => {
      assert.equal(reflection.isModel({}), false);
      assert.equal(reflection.isModel(null), false);
      assert.equal(reflection.isModel(42), false);
      assert.equal(reflection.isModel('str'), false);
      assert.equal(reflection.isModel(undefined), false);
    });

    it('getModelType returns registered name', () => {
      reflection.registerModel('Counter', Counter);
      const c = new Counter();
      assert.equal(reflection.getModelType(c), 'Counter');
    });

    it('getModelType returns undefined for unregistered', () => {
      assert.equal(reflection.getModelType({}), undefined);
    });
  });

  describe('getInstanceId', () => {
    it('returns existing id from instances registry', () => {
      const c = new Counter();
      instances.register('42', c);
      assert.equal(reflection.getInstanceId(c), '42');
    });

    it('uses model id plain property', () => {
      const obj = {id: 'my-id'};
      assert.equal(reflection.getInstanceId(obj), 'my-id');
    });

    it('unwraps Signal id property via peek()', () => {
      const obj = {id: signal('sig-id')};
      assert.equal(reflection.getInstanceId(obj), 'sig-id');
    });

    it('auto-generates id for models without id', () => {
      const obj = {name: 'no-id'};
      const id = reflection.getInstanceId(obj);
      assert.ok(id);
      assert.equal(typeof id, 'string');
    });

    it('auto-generated id is stable (same object -> same id)', () => {
      const obj = {name: 'no-id'};
      const id1 = reflection.getInstanceId(obj);
      const id2 = reflection.getInstanceId(obj);
      assert.equal(id1, id2);
    });
  });

  describe('serialize', () => {
    it('serializes model signals as {@S: id, v: value} markers', () => {
      const {serialized} = setupCounter();
      assert.ok(serialized.count['@S']);
      assert.equal(serialized.count.v, 0);
      assert.ok(serialized.name['@S']);
      assert.equal(serialized.name.v, 'default');
    });

    it('assigns unique signal IDs to different signals', () => {
      const {serialized} = setupCounter();
      const ids = new Set([
        serialized.count['@S'],
        serialized.name['@S'],
        serialized.items['@S'],
        serialized.meta['@S'],
      ]);
      assert.equal(ids.size, 4);
    });

    it('same signal gets same ID across serializations', () => {
      reflection.registerModel('Counter', Counter);
      const c = new Counter();
      instances.register('0', c);
      const r1 = reflection.serialize(c);
      const r2 = reflection.serialize(c);
      assert.equal(r1.count['@S'], r2.count['@S']);
    });

    it('serializes model with @M marker and signal props', () => {
      const {serialized} = setupCounter();
      assert.ok(serialized['@M']);
      assert.ok(serialized['@M'].startsWith('Counter#'));
      assert.ok(serialized.count);
      assert.equal(serialized.count.v, 0);
    });

    it('skips properties starting with _', () => {
      const {serialized} = setupCounter();
      assert.equal(serialized._internal, undefined);
    });

    it('skips function properties on models', () => {
      const {serialized} = setupCounter();
      assert.equal(serialized.increment, undefined);
      assert.equal(serialized.add, undefined);
      assert.equal(serialized.rename, undefined);
    });

    it('deduplicates models per client - second ref is just {@M: marker}', () => {
      reflection.registerModel('Counter', Counter);
      const c = new Counter();
      instances.register('0', c);

      const first = reflection.serialize(c, 'clientA');
      assert.ok(first.count);

      const second = reflection.serialize(c, 'clientA');
      assert.equal(second['@M'], first['@M']);
      assert.equal(second.count, undefined);
    });

    it('different clients get full serialization independently', () => {
      reflection.registerModel('Counter', Counter);
      const c = new Counter();
      instances.register('0', c);

      const forA = reflection.serialize(c, 'clientA');
      const forB = reflection.serialize(c, 'clientB');
      assert.ok(forA.count);
      assert.ok(forB.count);
    });

    it('auto-registers model instance in instances registry', () => {
      reflection.registerModel('Counter', Counter);
      const c = new Counter();
      (c as any).id = 'auto-99';
      const result = reflection.serialize(c);
      assert.equal(result['@M'], 'Counter#auto-99');
      assert.equal(instances.get('auto-99'), c);
    });

    it('handles null values', () => {
      const result = reflection.serialize(null);
      assert.equal(result, null);
    });

    it('serializes plain values as-is', () => {
      assert.equal(reflection.serialize(42), 42);
      assert.equal(reflection.serialize('hello'), 'hello');
      assert.deepEqual(reflection.serialize([1, 2]), [1, 2]);
    });

    it('skips rpc, reflection, and instances references in serialized output', () => {
      reflection.registerModel('Counter', Counter);
      const c = new Counter();
      (c as any).rpc = mockRpc;
      (c as any).reflection = reflection;
      (c as any).instances = instances;
      instances.register('0', c);
      const result = reflection.serialize(c);
      assert.equal(result.rpc, undefined);
      assert.equal(result.reflection, undefined);
      assert.equal(result.instances, undefined);
    });
  });

  describe('watch / unwatch', () => {
    it('watch subscribes client to signal updates', () => {
      const {counter, countId} = setupCounter('clientA');
      sentMessages.length = 0;
      reflection.watch('clientA', countId);

      counter.count.value = 10;
      const msgs = sentMessages.filter((m) => m.msg.includes('@S'));
      assert.ok(msgs.length > 0);
      assert.equal(msgs[0].clientId, 'clientA');
    });

    it('unwatch removes client from signal subscribers', () => {
      const {counter, countId} = setupCounter('clientA');
      sentMessages.length = 0;
      reflection.watch('clientA', countId);

      counter.count.value = 1;
      const msgCount = sentMessages.length;

      reflection.unwatch('clientA', countId);
      counter.count.value = 2;
      assert.equal(sentMessages.length, msgCount);
    });

    it('multiple clients receive independent updates', () => {
      reflection.registerModel('Counter', Counter);
      const c = new Counter();
      instances.register('0', c);
      const serialized = reflection.serialize(c, 'clientA');
      reflection.serialize(c, 'clientB');
      const countId = serialized.count['@S'] as number;
      sentMessages.length = 0;

      reflection.watch('clientA', countId);
      reflection.watch('clientB', countId);

      c.count.value = 5;
      const messages = sentMessages.filter((m) => m.msg.includes('@S'));
      assert.equal(messages.length, 2);
      assert.ok(messages.some((m) => m.clientId === 'clientA'));
      assert.ok(messages.some((m) => m.clientId === 'clientB'));
    });
  });

  describe('notifySubscribers / delta compression', () => {
    it('skips clients where value has not changed', () => {
      const {counter, countId} = setupCounter('clientA');
      sentMessages.length = 0;
      reflection.watch('clientA', countId);

      counter.count.value = 5;
      const count = sentMessages.length;

      // Set to same value — should not send
      counter.count.value = 5;
      assert.equal(sentMessages.length, count);
    });

    it('sends delta for array append', () => {
      const {counter, itemsId} = setupCounter('clientA');
      sentMessages.length = 0;
      reflection.watch('clientA', itemsId);

      counter.items.value = ['a', 'b', 'c'];
      sentMessages.length = 0; // clear the initial full-value update

      counter.items.value = ['a', 'b', 'c', 'd', 'e'];
      const msg = sentMessages.find((m) => m.clientId === 'clientA')!;
      assert.ok(msg);
      assert.ok(msg.msg.includes('"append"'), `Expected append in: ${msg.msg}`);
      assert.ok(
        msg.msg.includes('"d"') && msg.msg.includes('"e"'),
        `Expected new items in: ${msg.msg}`,
      );
    });

    it('sends full replacement for non-append array change', () => {
      const {counter, itemsId} = setupCounter('clientA');
      sentMessages.length = 0;
      reflection.watch('clientA', itemsId);

      // First, establish a non-empty baseline
      counter.items.value = ['a', 'b', 'c'];
      sentMessages.length = 0;

      // Now replace with a completely different array (not a prefix match)
      counter.items.value = ['x', 'y'];
      const msg = sentMessages.find((m) => m.clientId === 'clientA')!;
      assert.ok(msg);
      assert.ok(
        !msg.msg.includes('"append"'),
        `Should not be append: ${msg.msg}`,
      );
    });

    it('sends delta for object merge', () => {
      const {counter, metaId} = setupCounter('clientA');
      sentMessages.length = 0;
      reflection.watch('clientA', metaId);

      counter.meta.value = {version: 2};
      const msg = sentMessages.find((m) => m.clientId === 'clientA')!;
      assert.ok(msg);
      assert.ok(msg.msg.includes('"merge"'), `Expected merge in: ${msg.msg}`);
    });

    it('sends delta for string append', () => {
      const {counter, nameId} = setupCounter('clientA');
      sentMessages.length = 0;
      reflection.watch('clientA', nameId);

      counter.name.value = 'default-extended';
      const msg = sentMessages.find((m) => m.clientId === 'clientA')!;
      assert.ok(msg);
      assert.ok(msg.msg.includes('"append"'), `Expected append in: ${msg.msg}`);
      assert.ok(
        msg.msg.includes('"-extended"'),
        `Expected appended part in: ${msg.msg}`,
      );
    });

    it('sends full replacement when no delta applies', () => {
      const {counter, nameId} = setupCounter('clientA');
      sentMessages.length = 0;
      reflection.watch('clientA', nameId);

      counter.name.value = 'completely different';
      const msg = sentMessages.find((m) => m.clientId === 'clientA')!;
      assert.ok(msg);
      assert.ok(
        !msg.msg.includes('"append"'),
        `Should not be append: ${msg.msg}`,
      );
      assert.ok(
        !msg.msg.includes('"merge"'),
        `Should not be merge: ${msg.msg}`,
      );
    });

    it('serializes nested model references in method results', () => {
      reflection.registerModel('Counter', Counter);
      const child = new Counter();
      (child as any).id = 'c1';
      child.name.value = 'child-counter';

      // Serialize a wrapper object containing the model
      const wrapper = {child};
      const result = reflection.serialize(wrapper, 'clientA');
      assert.ok(result.child);
      assert.equal(result.child['@M'], 'Counter#c1');
      assert.ok(result.child.name);
      assert.equal(result.child.name.v, 'child-counter');
    });
  });

  describe('removeClient', () => {
    it('removes client from all subscriptions', () => {
      const {counter, countId} = setupCounter('clientA');
      sentMessages.length = 0;
      reflection.watch('clientA', countId);

      reflection.removeClient('clientA');

      counter.count.value = 99;
      const msgs = sentMessages.filter((m) => m.clientId === 'clientA');
      assert.equal(msgs.length, 0);
    });

    it('clears sentModels so re-added client gets full data', () => {
      reflection.registerModel('Counter', Counter);
      const c = new Counter();
      instances.register('0', c);

      reflection.serialize(c, 'clientA');
      const deduped = reflection.serialize(c, 'clientA');
      assert.equal(deduped.count, undefined);

      reflection.removeClient('clientA');
      const fresh = reflection.serialize(c, 'clientA');
      assert.ok(fresh.count);
    });
  });
});
