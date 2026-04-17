import {signal} from '@preact/signals-core';
import {createModel} from '../server/model.ts';
import type {Transport} from '../shared/protocol.ts';

export {createMemoryTransportPair} from '../server/memory-transport.ts';

type MessageHandler = (data: {toString(): string}) => void | Promise<void>;

/**
 * Creates a linked transport pair with an explicit message queue. Messages
 * are enqueued synchronously but delivered only when flush() is called,
 * giving tests full control over message ordering and timing.
 */
export function createLinkedTransportPair(): {
  serverTransport: Transport;
  clientTransport: Transport;
  flush: () => Promise<void>;
} {
  const queue: Array<() => Promise<void>> = [];
  const handlers: Record<string, MessageHandler | undefined> = {};

  const enqueue = (key: string, data: string) => {
    queue.push(async () => {
      await handlers[key]?.({toString: () => data});
    });
  };

  return {
    serverTransport: {
      send(data: string) {
        enqueue('client', data);
      },
      onMessage(cb) {
        handlers.server = cb;
      },
    },
    clientTransport: {
      send(data: string) {
        enqueue('server', data);
      },
      onMessage(cb) {
        handlers.client = cb;
      },
    },
    async flush() {
      while (queue.length > 0) {
        const pending = queue.splice(0);
        for (const deliver of pending) {
          await deliver();
        }
      }
    },
  };
}

export const Counter = createModel<{
  count: ReturnType<typeof signal<number>>;
  name: ReturnType<typeof signal<string>>;
  items: ReturnType<typeof signal<string[]>>;
  meta: ReturnType<typeof signal<Record<string, any>>>;
  increment(): void;
  add(item: string): void;
  rename(name: string): void;
}>('Counter', () => {
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

export function flush(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
