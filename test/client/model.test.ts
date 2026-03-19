import {type Signal, signal} from '@preact/signals-core';
import {describe, expect, it, vi} from 'vitest';
import {createReflectedModel} from '../../client/model.ts';
import type {WireContext} from '../../client/reflection.ts';
import type {RPCClient} from '../../client/rpc.ts';

describe('createReflectedModel', () => {
  it('exposes id signal with wireId value', () => {
    const Model = createReflectedModel<{id: Signal<string>}>([], []);
    const ctx = {
      rpc: {call: vi.fn(async () => undefined)} satisfies Partial<RPCClient>,
    } as unknown as WireContext;
    const instance = new Model(ctx, {'@wireId': 'abc-123'});
    expect(instance.id.peek()).toBe('abc-123');
  });

  it('creates computed signal properties from server signals', () => {
    const Model = createReflectedModel<{
      id: Signal<string>;
      count: Signal<number>;
      name: Signal<string>;
    }>(['count', 'name'], []);

    const ctx = {
      rpc: {call: vi.fn(async () => undefined)} satisfies Partial<RPCClient>,
    } as unknown as WireContext;
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

    const ctx = {
      rpc: {call: vi.fn(async () => undefined)} satisfies Partial<RPCClient>,
    } as unknown as WireContext;
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
    const ctx = {
      rpc: {call} satisfies Partial<RPCClient>,
    } as unknown as WireContext;
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
    const ctx = {
      rpc: {call} satisfies Partial<RPCClient>,
    } as unknown as WireContext;
    const instance = new Model(ctx, {'@wireId': 'w1'});

    const result = await instance.getData();
    expect(result).toBe('result:w1#getData');
  });

  it('uses wire-id routes for instance methods and eager signal props', async () => {
    const TaskModel = createReflectedModel<{
      id: Signal<string>;
      title: Signal<string>;
      toggle(): Promise<unknown>;
    }>(['title'], ['toggle']);

    const call = vi.fn(async () => ({done: true}));
    const ctx = {
      rpc: {call} satisfies Partial<RPCClient>,
    } as unknown as WireContext;
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
