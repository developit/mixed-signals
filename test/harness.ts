import {effect, type Signal, signal} from '@preact/signals-core';
import {createReflectedModel} from '../client/model.ts';
import {RPCClient} from '../client/rpc.ts';
import type {Transport} from '../shared/protocol.ts';
import {createModel} from '../server/model.ts';
import {RPC} from '../server/rpc.ts';

/**
 * A transport pair whose two directions are queued and delivered only on
 * demand, so a test can interleave one client's traffic against another's over
 * the real wire (real serialization, real `@S` deltas, real call-id echo).
 */
interface ControlledPair {
  readonly serverTransport: Transport;
  readonly clientTransport: Transport;
  readonly toServer: string[];
  readonly toClient: string[];
  serverHandler?: (data: {toString(): string}) => void | Promise<void>;
  clientHandler?: (data: {toString(): string}) => void | Promise<void>;
}

function controlledPair(): ControlledPair {
  const pair: ControlledPair = {
    toServer: [],
    toClient: [],
    serverTransport: {
      send: (data) => void pair.toClient.push(data),
      onMessage: (cb) => {
        pair.serverHandler = cb;
      },
    },
    clientTransport: {
      send: (data) => void pair.toServer.push(data),
      onMessage: (cb) => {
        pair.clientHandler = cb;
      },
    },
  };
  return pair;
}

const realDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function drain(
  queue: string[],
  handler: ((data: {toString(): string}) => void | Promise<void>) | undefined,
  limit = Infinity,
): Promise<boolean> {
  if (queue.length === 0) return false;
  const batch = queue.splice(0, limit);
  for (const message of batch) {
    await handler?.({toString: () => message});
  }
  return true;
}

/** A connected client: its `RPCClient`, its root facade, and per-direction delivery control. */
export interface HarnessClient<Root> {
  readonly rpc: RPCClient<Root>;
  root(): Root;
  /** Deliver this client's queued outbound messages to the server. */
  flushOut(): Promise<boolean>;
  /** Deliver the server's queued messages to this client, at most `limit`. */
  flushIn(limit?: number): Promise<boolean>;
}

/** One `RPC` server plus any number of independently controllable clients. */
export class Harness<Root> {
  readonly rpc: RPC;
  private readonly pairs: ControlledPair[] = [];

  constructor(root: unknown, register?: (rpc: RPC) => void) {
    this.rpc = new RPC(root);
    register?.(this.rpc);
  }

  async connect(
    id: string,
    register?: (client: RPCClient<Root>) => void,
  ): Promise<HarnessClient<Root>> {
    const pair = controlledPair();
    this.pairs.push(pair);
    const rpc = new RPCClient<Root>(pair.clientTransport);
    register?.(rpc);
    this.rpc.addClient(pair.serverTransport, id);

    const handle: HarnessClient<Root> = {
      rpc,
      root: () => rpc.root,
      flushOut: () => drain(pair.toServer, pair.serverHandler),
      flushIn: (limit?: number) => drain(pair.toClient, pair.clientHandler, limit),
    };

    await this.settle();
    await rpc.ready;
    return handle;
  }

  /** Deliver all queued traffic in both directions until nothing remains. */
  async settle(): Promise<void> {
    for (let pass = 0; pass < 100; pass++) {
      await realDelay(2);
      let moved = false;
      for (const pair of this.pairs) {
        if (await drain(pair.toServer, pair.serverHandler)) moved = true;
        if (await drain(pair.toClient, pair.clientHandler)) moved = true;
      }
      const pending = this.pairs.some((p) => p.toServer.length || p.toClient.length);
      if (!moved && !pending) return;
    }
    throw new Error('harness.settle: traffic did not quiesce');
  }
}

export interface Card {
  id: string;
  text: string;
}

export interface BoardApi {
  title: Signal<string>;
  cards: Signal<Card[]>;
  rename(next: string): {ok: true};
  editCard(id: string, text: string): {ok: true};
  addCard(card: Card): {ok: true};
}

/**
 * A server board with a scalar `title` and a keyed `cards` list. `rename` and
 * `editCard` normalize their input (trim / upper-case) so tests can tell a
 * server-normalized echo of the caller's own edit apart from a concurrent
 * write by another client. `addCardsTwice` writes `cards` twice in one call to
 * exercise per-call batching of signal updates.
 */
export const Board = createModel<BoardApi & {addCardsTwice(a: Card, b: Card): {ok: true}}>(
  () => {
    const title = signal('untitled');
    const cards = signal<Card[]>([]);
    return {
      title,
      cards,
      rename(next: string) {
        title.value = next.trim();
        return {ok: true} as const;
      },
      editCard(id: string, text: string) {
        cards.value = cards.value.map((card) =>
          card.id === id ? {...card, text: text.toUpperCase()} : card,
        );
        return {ok: true} as const;
      },
      addCard(card: Card) {
        cards.value = [...cards.value, card];
        return {ok: true} as const;
      },
      addCardsTwice(a: Card, b: Card) {
        cards.value = [...cards.value, a];
        cards.value = [...cards.value, b];
        return {ok: true} as const;
      },
    };
  },
);

export const BoardModel = createReflectedModel<BoardApi>(
  ['title', 'cards'],
  ['rename', 'editCard', 'addCard'],
);

export type BoardFacade = InstanceType<typeof BoardModel>;

export interface BoardRoot {
  board: BoardFacade;
}

/** The board facade for a connected client. */
export function boardOf(client: HarnessClient<BoardRoot>): BoardFacade {
  return client.root().board;
}

/** Subscribe to a signal and record every value the UI would render. */
export function record<T>(read: () => T): {frames: T[]; stop: () => void} {
  const frames: T[] = [];
  const stop = effect(() => {
    frames.push(read());
  });
  return {frames, stop};
}
