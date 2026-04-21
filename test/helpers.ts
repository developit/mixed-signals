import {signal} from '@preact/signals-core';
import {createModel} from '../server/model.ts';
import type {
  RawTransport,
  Transport,
  TransportContext,
} from '../shared/protocol.ts';

export {
  createMemoryTransportPair,
  createRawMemoryTransportPair,
} from '../server/memory-transport.ts';

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

type RawHandler = (
  data: unknown,
  ctx?: TransportContext,
) => void | Promise<void>;

/**
 * Raw-mode counterpart to `createLinkedTransportPair` — messages are enqueued
 * synchronously, delivered only when `flush()` is called, and structurally
 * cloned at the boundary (mirroring real postMessage semantics). The enqueued
 * ctx also gets `transfer` stripped before delivery, matching what a receiver
 * would actually see.
 */
export function createLinkedRawTransportPair(): {
  serverTransport: RawTransport;
  clientTransport: RawTransport;
  flush: () => Promise<void>;
  /** All ctx objects observed on the server → client channel (sender-side). */
  sentCtxToClient: TransportContext[];
  sentCtxToServer: TransportContext[];
} {
  const queue: Array<() => Promise<void>> = [];
  const handlers: Record<string, RawHandler | undefined> = {};
  const sentCtxToClient: TransportContext[] = [];
  const sentCtxToServer: TransportContext[] = [];

  const enqueue = (key: string, data: unknown, ctx: TransportContext | undefined) => {
    const cloned = structuredClone(data);
    let forwardedCtx: TransportContext | undefined;
    if (ctx) {
      forwardedCtx = {};
      for (const k of Object.keys(ctx)) {
        if (k === 'transfer') continue;
        forwardedCtx[k] = (ctx as Record<string, unknown>)[k];
      }
    }
    queue.push(async () => {
      await handlers[key]?.(cloned, forwardedCtx);
    });
  };

  return {
    serverTransport: {
      mode: 'raw',
      send(data, ctx) {
        if (ctx) sentCtxToClient.push(ctx);
        enqueue('client', data, ctx);
      },
      onMessage(cb) {
        handlers.server = cb;
      },
    },
    clientTransport: {
      mode: 'raw',
      send(data, ctx) {
        if (ctx) sentCtxToServer.push(ctx);
        enqueue('server', data, ctx);
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
    sentCtxToClient,
    sentCtxToServer,
  };
}
