import {
  computed,
  effect,
  type ReadonlySignal,
  type Signal,
  signal,
} from '@preact/signals-core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createReflectedModel} from '../../client/model.ts';
import {
  asReflected,
  linkSource,
  optimistic,
  type OptimisticTransaction,
  type ReflectedSignal,
} from '../../client/optimistic.ts';
import {RPCClient} from '../../client/rpc.ts';
import type {Transport} from '../../shared/protocol.ts';
import {RPC} from '../../server/rpc.ts';
import {createLinkedTransportPair} from '../helpers.ts';

const settle = () => Promise.resolve().then(() => Promise.resolve());

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

const silentTransport: Transport = {send() {}, onMessage() {}};

interface Reflected<T> {
  view: ReflectedSignal<T>;
  rendered: T[];
  push(delta: unknown, mode?: string): void;
}

function reflected<T>(
  id: number,
  initial: T,
  options?: {raw?: boolean},
): Reflected<T> {
  const {reflection} = new RPCClient(silentTransport);
  const source = reflection.getOrCreateSignal(id, initial) as Signal<T>;
  const view = options?.raw
    ? linkSource(source, source)
    : linkSource(computed(() => source.value), source);

  const rendered: T[] = [];
  effect(() => {
    rendered.push(view.value);
  });

  return {
    view,
    rendered,
    push: (delta, mode) => reflection.handleUpdate(id, delta, mode),
  };
}

interface Message {
  id: string;
  text: string;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('optimistic — core behaviour', () => {
  it('shows the optimistic value immediately on the rendered signal', () => {
    const {view} = reflected<Message[]>(1, [{id: 's1', text: 'a'}]);

    optimistic(undefined, (tx) => {
      tx.update(view, (messages) => [...messages, {id: 'tmp', text: 'b'}]);
    });

    expect(view.peek()).toEqual([
      {id: 's1', text: 'a'},
      {id: 'tmp', text: 'b'},
    ]);
  });

  it('works on a raw reflected signal with no facade', () => {
    const {view} = reflected(1, 'hello', {raw: true});

    optimistic(undefined, (tx) => tx.set(view, 'hello world'));

    expect(view.peek()).toBe('hello world');
  });

  it('rolls back to the server value when the action rejects', async () => {
    const {view, push} = reflected(1, 'real');
    const action = deferred();

    optimistic(action.promise, (tx) => tx.set(view, 'optimistic'));
    expect(view.peek()).toBe('optimistic');

    action.reject(new Error('server said no'));
    await settle();
    expect(view.peek()).toBe('real');

    push('fresh');
    expect(view.peek()).toBe('fresh');
  });

  it('restores the server value on manual rollback without an action', () => {
    const {view} = reflected(1, 'real');

    const handle = optimistic(undefined, (tx) => tx.set(view, 'optimistic'));
    expect(view.peek()).toBe('optimistic');

    handle.rollback();
    expect(view.peek()).toBe('real');
  });

  it('is idempotent across rollback and a settled action', async () => {
    const {view, push} = reflected(1, 'real');
    const action = deferred();

    const handle = optimistic(action.promise, (tx) => tx.set(view, 'optimistic'));
    handle.rollback();
    action.resolve();
    await settle();

    expect(view.peek()).toBe('real');
    push('next');
    expect(view.peek()).toBe('next');
  });
});

describe('asReflected — checked refinement', () => {
  it('narrows a reflected signal so it can drive optimistic()', () => {
    const {view} = reflected<Message[]>(1, [{id: 's1', text: 'a'}]);
    // Re-type the reflected signal as a plain ReadonlySignal, as a generated
    // transport interface would, then recover the brand through asReflected.
    const loose: ReadonlySignal<Message[]> = view;

    optimistic(undefined, (tx) =>
      tx.update(asReflected(loose), (messages) => [
        ...messages,
        {id: 'tmp', text: 'b'},
      ]),
    );

    expect(view.peek().map((message) => message.id)).toEqual(['s1', 'tmp']);
  });

  it('throws on a plain, non-reflected signal', () => {
    const plain = signal('local');
    expect(() => asReflected(plain)).toThrow(TypeError);
  });
});

describe('optimistic — reconciliation', () => {
  it('reconciles to server truth without flicker when the push precedes the reply', async () => {
    const {view, rendered, push} = reflected(1, 'v1');
    const action = deferred();

    optimistic(action.promise, (tx) => tx.set(view, 'v2'));
    push('v2');
    action.resolve();
    await settle();

    expect(view.peek()).toBe('v2');
    expect(rendered).toEqual(['v1', 'v2']);
  });

  it('keeps the optimistic value layered over unrelated server deltas in flight', async () => {
    const {view, push} = reflected<Record<string, string>>(1, {
      title: 'old',
      status: 'idle',
    });
    const action = deferred();

    optimistic(action.promise, (tx) =>
      tx.update(view, (object) => ({...object, title: 'new'})),
    );
    expect(view.peek()).toEqual({title: 'new', status: 'idle'});

    push({status: 'running'}, 'merge');
    expect(view.peek()).toEqual({title: 'new', status: 'running'});

    push({title: 'new'}, 'merge');
    action.resolve();
    await settle();

    expect(view.peek()).toEqual({title: 'new', status: 'running'});
  });

  it('drops to server truth when the action resolves and no delta echoes', async () => {
    const {view, push} = reflected(1, 'server');
    const action = deferred();

    optimistic(action.promise, (tx) => tx.set(view, 'optimistic'));
    expect(view.peek()).toBe('optimistic');

    action.resolve();
    await settle();

    expect(view.peek()).toBe('server');

    push('later');
    expect(view.peek()).toBe('later');
  });
});

describe('optimistic — until (source-driven reconciliation)', () => {
  it('reconciles a list insert the moment the server reflects it, ignoring the action', async () => {
    const {view, rendered, push} = reflected<Message[]>(1, [{id: 's1', text: 'a'}]);
    const action = deferred();

    optimistic(action.promise, (tx) =>
      tx.update(view, (messages) => [...messages, {id: 'tmp', text: 'b'}], {
        until: (server) => server.length > 1,
      }),
    );
    expect(view.peek().map((message) => message.id)).toEqual(['s1', 'tmp']);

    // The server append confirms the insert; the patch drops in the same update.
    push([{id: 's2', text: 'b'}], 'append');
    expect(view.peek().map((message) => message.id)).toEqual(['s1', 's2']);
    // No flicker: the duplicate ['s1','s2','tmp'] is never rendered.
    expect(rendered.some((value) => value.length === 3)).toBe(false);

    // The action settling afterwards is a no-op (already reconciled).
    action.resolve();
    await settle();
    expect(view.peek().map((message) => message.id)).toEqual(['s1', 's2']);
  });

  it('keeps an until-patch when an unrelated delta does not satisfy it', () => {
    const {view, push} = reflected<Record<string, string>>(1, {
      title: 'old',
      status: 'idle',
    });

    optimistic(undefined, (tx) =>
      tx.update(view, (object) => ({...object, title: 'new'}), {
        until: (server) => server.title === 'new',
      }),
    );
    expect(view.peek()).toEqual({title: 'new', status: 'idle'});

    // Unrelated field update: predicate stays false, optimistic title survives.
    push({status: 'running'}, 'merge');
    expect(view.peek()).toEqual({title: 'new', status: 'running'});

    // The confirming delta satisfies the predicate; the patch reconciles away.
    push({title: 'new'}, 'merge');
    expect(view.peek()).toEqual({title: 'new', status: 'running'});
  });

  it('still rolls back via the action when the server never reflects the change', async () => {
    const {view} = reflected(1, 'real');
    const action = deferred();

    optimistic(action.promise, (tx) =>
      tx.set(view, 'optimistic', {until: (server) => server === 'optimistic'}),
    );
    expect(view.peek()).toBe('optimistic');

    action.reject(new Error('server said no'));
    await settle();
    expect(view.peek()).toBe('real');
  });
});

describe('optimistic — multiple changes', () => {
  it('keeps concurrent patches on one signal until each action settles', async () => {
    const {view, push} = reflected<Message[]>(1, []);
    const a = deferred();
    const b = deferred();

    optimistic(a.promise, (tx) =>
      tx.update(view, (messages) => [...messages, {id: 'a', text: 'A'}]),
    );
    optimistic(b.promise, (tx) =>
      tx.update(view, (messages) => [...messages, {id: 'b', text: 'B'}]),
    );
    expect(view.peek().map((message) => message.id)).toEqual(['a', 'b']);

    push([{id: 'other', text: 'O'}], 'append');
    expect(view.peek().map((message) => message.id)).toEqual([
      'other',
      'a',
      'b',
    ]);

    a.resolve();
    await settle();
    expect(view.peek().map((message) => message.id)).toEqual(['other', 'b']);

    b.reject();
    await settle();
    expect(view.peek().map((message) => message.id)).toEqual(['other']);
  });

  it('rolls back a single pending patch independently', async () => {
    const {view} = reflected<Message[]>(1, []);
    const a = deferred();
    const b = deferred();

    const opA = optimistic(a.promise, (tx) =>
      tx.update(view, (messages) => [...messages, {id: 'a', text: 'A'}]),
    );
    optimistic(b.promise, (tx) =>
      tx.update(view, (messages) => [...messages, {id: 'b', text: 'B'}]),
    );

    opA.rollback();
    expect(view.peek().map((message) => message.id)).toEqual(['b']);
  });

  it('applies a single transaction across multiple signals', async () => {
    const list = reflected<Message[]>(1, []);
    const title = reflected(2, 'untitled');
    const action = deferred();

    optimistic(action.promise, (tx) => {
      tx.update(list.view, (messages) => [...messages, {id: 'x', text: 'X'}]);
      tx.set(title.view, 'New Title');
    });
    expect(list.view.peek().map((message) => message.id)).toEqual(['x']);
    expect(title.view.peek()).toBe('New Title');

    action.reject();
    await settle();
    expect(list.view.peek()).toEqual([]);
    expect(title.view.peek()).toBe('untitled');
  });
});

describe('optimistic — compaction splice', () => {
  it('optimistically splices a marker and reconciles to the server splice', async () => {
    const initial: Message[] = [
      {id: 'm1', text: 'one'},
      {id: 'm2', text: 'two'},
      {id: 'm3', text: 'three'},
    ];
    const {view, push} = reflected<Message[]>(1, initial);
    const action = deferred();

    optimistic(action.promise, (tx) =>
      tx.update(view, (messages) => [
        ...messages.slice(0, -1),
        {id: 'compaction', text: 'compacting…'},
        messages[messages.length - 1],
      ]),
    );
    expect(view.peek().map((message) => message.id)).toEqual([
      'm1',
      'm2',
      'compaction',
      'm3',
    ]);

    push(
      {start: 2, deleteCount: 0, items: [{id: 'c-server', text: 'compacted'}]},
      'splice',
    );
    action.resolve();
    await settle();

    expect(view.peek().map((message) => message.id)).toEqual([
      'm1',
      'm2',
      'c-server',
      'm3',
    ]);
  });
});

describe('optimistic — wire delta guards', () => {
  it('ignores a merge delta against an array-valued base', () => {
    const {view, push} = reflected<Message[]>(1, [{id: 's1', text: 'a'}]);
    const action = deferred();

    optimistic(action.promise, (tx) =>
      tx.update(view, (messages) => [...messages, {id: 'tmp', text: 'b'}]),
    );

    push({rogue: true}, 'merge');

    expect(view.peek().map((message) => message.id)).toEqual(['s1', 'tmp']);
  });

  it('ignores a splice delta with non-integer bounds', () => {
    const {view, push} = reflected<number[]>(1, [1, 2, 3]);
    const action = deferred();

    optimistic(action.promise, (tx) => tx.update(view, (xs) => [...xs, 4]));

    push({start: 1.5, deleteCount: 0, items: [9]}, 'splice');

    expect(view.peek()).toEqual([1, 2, 3, 4]);
  });
});

describe('optimistic — documented tradeoff of key-less reconciliation', () => {
  it('briefly shows a duplicate for inserts when the push beats the reply', async () => {
    const {view, rendered, push} = reflected<Message[]>(1, [
      {id: 's1', text: 'a'},
    ]);
    const action = deferred();

    optimistic(action.promise, (tx) =>
      tx.update(view, (messages) => [...messages, {id: 'tmp', text: 'b'}]),
    );

    push([{id: 's2', text: 'b'}], 'append');
    expect(view.peek().map((message) => message.id)).toEqual(['s1', 's2', 'tmp']);
    expect(rendered.some((value) => value.length === 3)).toBe(true);

    action.resolve();
    await settle();
    expect(view.peek().map((message) => message.id)).toEqual(['s1', 's2']);
  });

  it('reverts to the server base when the reply precedes the delta', async () => {
    const {view, rendered, push} = reflected(1, 'untitled');
    const action = deferred();

    optimistic(action.promise, (tx) => tx.set(view, 'Renamed'));
    expect(view.peek()).toBe('Renamed');

    action.resolve();
    await settle();
    expect(view.peek()).toBe('untitled');

    push('Renamed');
    expect(view.peek()).toBe('Renamed');
    expect(rendered).toEqual(['untitled', 'Renamed', 'untitled', 'Renamed']);
  });

  it('pins the optimistic value until rollback when there is no action', () => {
    const {view, push} = reflected(1, 'v1');

    const handle = optimistic(undefined, (tx) => tx.set(view, 'optimistic'));
    push('v2');
    push('v3');
    expect(view.peek()).toBe('optimistic');

    handle.rollback();
    expect(view.peek()).toBe('v3');
  });
});

class Chat {
  messages = signal<Message[]>([]);
  title = signal('untitled');
  private seq = 0;

  send(text: string) {
    const message = {id: `s${++this.seq}`, text};
    this.messages.value = [...this.messages.value, message];
    return message;
  }

  boom(): never {
    throw new Error('rejected by server');
  }

  setTitle(next: string) {
    this.title.value = next;
    return {ok: true};
  }
}

interface ChatApi {
  messages: Signal<Message[]>;
  title: Signal<string>;
  send(text: string): Promise<Message>;
  boom(): Promise<never>;
  setTitle(next: string): Promise<{ok: boolean}>;
}

const ChatModel = createReflectedModel<ChatApi>(
  ['messages', 'title'],
  ['send', 'boom', 'setTitle'],
);

type ChatFacade = InstanceType<typeof ChatModel>;

async function connectChat() {
  const chat = new Chat();
  const rpc = new RPC({chat});
  rpc.registerModel('Chat', Chat);

  const {serverTransport, clientTransport, flush} = createLinkedTransportPair();
  const ctx = {rpc: null as unknown as RPCClient};
  const client = new RPCClient<{chat: ChatFacade}>(clientTransport, ctx);
  ctx.rpc = client;
  client.registerModel('Chat', ChatModel);
  rpc.addClient(serverTransport, 'c1');

  await flush();
  await client.ready;

  return {chat, facade: client.root.chat, flush};
}

describe('optimistic — end-to-end over the wire', () => {
  it('inserts optimistically and reconciles to the server message', async () => {
    vi.useFakeTimers();
    const {facade, flush} = await connectChat();

    const stop = facade.messages.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();

    const action = facade.send('hello');
    optimistic(action, (tx) =>
      tx.update(facade.messages, (messages) => [
        ...messages,
        {id: 'tmp', text: 'hello'},
      ]),
    );
    expect(facade.messages.peek().map((message) => message.text)).toEqual([
      'hello',
    ]);

    await flush();
    await action;
    await flush();

    const final = facade.messages.peek();
    expect(final.map((message) => message.text)).toEqual(['hello']);
    expect(final[0].id).toBe('s1');

    stop();
  });

  it('rolls back when the server rejects the action', async () => {
    vi.useFakeTimers();
    const {facade, flush} = await connectChat();

    const stop = facade.messages.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();

    const action = facade.boom();
    optimistic(action, (tx) =>
      tx.update(facade.messages, (messages) => [
        ...messages,
        {id: 'tmp', text: 'never'},
      ]),
    );
    expect(facade.messages.peek().map((message) => message.text)).toEqual([
      'never',
    ]);

    await flush();
    await expect(action).rejects.toThrow('rejected by server');
    await flush();

    expect(facade.messages.peek()).toEqual([]);

    stop();
  });

  it('reconciles an optimistic replace without flicker', async () => {
    vi.useFakeTimers();
    const {facade, flush} = await connectChat();

    const seen: string[] = [];
    effect(() => {
      seen.push(facade.title.value);
    });
    vi.advanceTimersByTime(1);
    await flush();

    const action = facade.setTitle('Renamed');
    optimistic(action, (tx) => tx.set(facade.title, 'Renamed'));
    expect(facade.title.peek()).toBe('Renamed');

    await flush();
    await action;
    await flush();

    expect(facade.title.peek()).toBe('Renamed');
    expect(seen).toEqual(['untitled', 'Renamed']);
  });
});

describe('optimistic — compile-time type safety', () => {
  it('rejects non-reflected signals, mistyped values, and mutation', () => {
    const guard = (tx: OptimisticTransaction) => {
      const plain = signal('local');
      // @ts-expect-error a plain signal is not a ReflectedSignal
      tx.set(plain, 'next');

      const text = reflected(90, 'x').view;
      // @ts-expect-error the value must match the signal's type
      tx.set(text, 123);

      const numbers = reflected<number[]>(91, []).view;
      tx.update(numbers, (current) => {
        // @ts-expect-error the current value is read-only
        current.push(1);
        return [...current];
      });
    };

    expect(typeof guard).toBe('function');
  });

  it('rejects signal props that are not keys of the model', () => {
    // @ts-expect-error 'missing' is not a signal prop of ChatApi
    createReflectedModel<ChatApi>(['missing'], []);
  });

  it('treats Map-valued reflected signals as read-only inside update', () => {
    const guard = (tx: OptimisticTransaction) => {
      const map = reflected<Map<string, number>>(95, new Map()).view;
      tx.update(map, (current) => {
        // @ts-expect-error a read-only map exposes no mutators
        current.set('x', 1);
        return new Map(current);
      });
    };

    expect(typeof guard).toBe('function');
  });

  it('maps facade signals and methods to reflected + async types', () => {
    const check = (facade: ChatFacade) => {
      const messages: ReflectedSignal<Message[]> = facade.messages;
      const sent: Promise<Message> = facade.send('hi');
      // @ts-expect-error facade methods are async, never sync
      const sync: Message = facade.send('hi');
      return {messages, sent, sync};
    };

    expect(typeof check).toBe('function');
  });

  it('treats a reflected signal as invariant in its value type', () => {
    interface Animal {
      legs: number;
    }
    interface Dog extends Animal {
      bark(): void;
    }

    const guard = (dog: ReflectedSignal<Dog>) => {
      // @ts-expect-error a Dog view cannot widen to an Animal view
      const animal: ReflectedSignal<Animal> = dog;
      return animal;
    };

    expect(typeof guard).toBe('function');
  });
});
