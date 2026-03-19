import {type Signal, signal} from '@preact/signals-core';
import {describe, expect, it, vi} from 'vitest';
import {createReflectedModel} from '../../client/model.ts';
import type {WireContext} from '../../client/reflection.ts';

describe('createReflectedModel', () => {
  it('exposes id signal with wireId value', () => {
    const Model = createReflectedModel<{id: Signal<string>}>([], []);
    const ctx: WireContext = {rpc: {call: vi.fn(async () => undefined)}};
    const instance = new Model(ctx, {'@wireId': 'abc-123'});
    expect(instance.id.peek()).toBe('abc-123');
  });

  it('creates computed signal properties from server signals', () => {
    const Model = createReflectedModel<{
      id: Signal<string>;
      count: Signal<number>;
      name: Signal<string>;
    }>(['count', 'name'], []);

    const ctx: WireContext = {rpc: {call: vi.fn(async () => undefined)}};
    const instance = new Model(ctx, {
      '@wireId': 'w1',
      count: signal(42),
      name: signal('test'),
    });

    expect(instance.count.peek()).toBe(42);
    expect(instance.name.peek()).toBe('test');
  });

  it('computed props update when source signals change', () => {
    const Model = createReflectedModel<{
      id: Signal<string>;
      count: Signal<number>;
    }>(['count'], []);

    const ctx: WireContext = {rpc: {call: vi.fn(async () => undefined)}};
    const source = signal(0);
    const instance = new Model(ctx, {'@wireId': 'w1', count: source});

    expect(instance.count.peek()).toBe(0);
    source.value = 99;
    expect(instance.count.peek()).toBe(99);
  });

  it('creates method proxies that call rpc.call with wireId#method', async () => {
    const Model = createReflectedModel<{
      id: Signal<string>;
      increment(): Promise<void>;
      rename(name: string): Promise<void>;
    }>([], ['increment', 'rename']);

    const call = vi.fn(async () => undefined);
    const ctx: WireContext = {rpc: {call}};
    const instance = new Model(ctx, {'@wireId': 'w7'});

    await instance.increment();
    expect(call).toHaveBeenCalledWith('w7#increment', []);

    await instance.rename('new-name');
    expect(call).toHaveBeenCalledWith('w7#rename', ['new-name']);
  });

  it('method proxies return rpc call result', async () => {
    const Model = createReflectedModel<{
      id: Signal<string>;
      getData(): Promise<string>;
    }>([], ['getData']);

    const call = vi.fn(async () => 'result:w1#getData');
    const ctx: WireContext = {rpc: {call}};
    const instance = new Model(ctx, {'@wireId': 'w1'});

    const result = await instance.getData();
    expect(result).toBe('result:w1#getData');
  });

  it('skips signal props not present in data', () => {
    const Model = createReflectedModel<{
      id: Signal<string>;
      missing: Signal<unknown>;
    }>(['missing'], []);

    const ctx: WireContext = {rpc: {call: vi.fn(async () => undefined)}};
    const instance = new Model(ctx, {'@wireId': 'w1'});

    // Missing signal props get a holder computed that returns undefined
    expect(instance.missing.value).toBeUndefined();
  });

  it('uses path-based routes and hydrates deferred signal props from results', async () => {
    const TodosModel = createReflectedModel<{
      id: Signal<string>;
      items: Signal<unknown>;
      list(): Promise<unknown>;
    }>(['items'], ['list'], 'todos');

    const itemsSignal = signal(['item-a']);
    const call = vi.fn(async () => ({items: itemsSignal}));
    const ctx: WireContext = {rpc: {call}};
    const instance = new TodosModel(ctx, {'@wireId': 't1'});

    // Before calling list, items holder is empty (deferred)
    expect(instance.items.value).toBeUndefined();

    // Call list — uses path-based route "todos.list"
    await instance.list();
    expect(call).toHaveBeenCalledWith('todos.list', []);

    // After call, the holder should be hydrated with the returned signal
    expect(instance.items.peek()).toEqual(['item-a']);

    // Source signal updates flow through
    itemsSignal.value = ['item-a', 'item-b'];
    expect(instance.items.peek()).toEqual(['item-a', 'item-b']);
  });

  it('uses wire-id routes for instance methods and eager signal props', async () => {
    const TaskModel = createReflectedModel<{
      id: Signal<string>;
      title: Signal<string>;
      toggle(): Promise<unknown>;
    }>(['title'], ['toggle']);

    const call = vi.fn(async () => ({done: true}));
    const ctx: WireContext = {rpc: {call}};
    const titleSignal = signal('Ship it');
    const instance = new TaskModel(ctx, {
      '@wireId': 'w42',
      title: titleSignal,
    });

    // Eager signal prop is immediately available
    expect(instance.title.peek()).toBe('Ship it');

    // Instance method uses wireId#method route (no path)
    await instance.toggle();
    expect(call).toHaveBeenCalledWith('w42#toggle', []);

    // Source signal updates still propagate
    titleSignal.value = 'Shipped!';
    expect(instance.title.peek()).toBe('Shipped!');
  });
});
