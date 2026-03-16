import {signal} from '@preact/signals-core';
import {createReflectedModel} from '../client/model.ts';
import {createModel} from '../server/model.ts';
import type {Transport} from '../server/rpc.ts';

export function createTransportPair(): {server: Transport; client: Transport} {
  let serverCb: ((data: {toString(): string}) => void) | null = null;
  let clientCb: ((data: {toString(): string}) => void) | null = null;

  const server: Transport = {
    send(data: string) {
      clientCb?.({toString: () => data});
    },
    onMessage(cb) {
      serverCb = cb;
    },
  };

  const client: Transport = {
    send(data: string) {
      serverCb?.({toString: () => data});
    },
    onMessage(cb) {
      clientCb = cb;
    },
  };

  return {server, client};
}

export const Counter = createModel<{
  count: ReturnType<typeof signal<number>>;
  name: ReturnType<typeof signal<string>>;
  items: ReturnType<typeof signal<string[]>>;
  meta: ReturnType<typeof signal<Record<string, any>>>;
  _internal: string;
  increment(): void;
  add(item: string): void;
  rename(name: string): void;
}>(() => {
  const count = signal(0);
  const name = signal('default');
  const items = signal<string[]>([]);
  const meta = signal<Record<string, any>>({version: 1});
  return {
    count,
    name,
    items,
    meta,
    _internal: 'hidden',
    increment() {
      count.value++;
    },
    add(item: string) {
      items.value = [...items.value, item];
    },
    rename(newName: string) {
      name.value = newName;
    },
  };
});

export const ReflectedCounter = createReflectedModel<{
  id: ReturnType<typeof signal<string>>;
  count: ReturnType<typeof signal<number>>;
  name: ReturnType<typeof signal<string>>;
  items: ReturnType<typeof signal<string[]>>;
  meta: ReturnType<typeof signal<Record<string, any>>>;
  increment(): Promise<void>;
  add(item: string): Promise<void>;
  rename(name: string): Promise<void>;
}>(['count', 'name', 'items', 'meta'], ['increment', 'add', 'rename']);

export function flush(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
