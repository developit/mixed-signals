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
  type OptimisticConflict,
  type OptimisticTransaction,
  type ReflectedSignal,
  registerCall,
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
  push(delta: unknown, mode?: string, cmid?: number): void;
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
    push: (delta, mode, cmid) => reflection.handleUpdate(id, delta, mode, cmid),
  };
}

interface Message {
  id: string;
  text: string;
  cid?: string;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('optimistic — core behaviour', () => {
  it('shows the optimistic value immediately on the rendered signal', () => {
    const {view} = reflected<Message[]>(1, [{id: 's1', text: 'a'}]);

    optimistic(new Promise<never>(() => {}), (tx) => {
      tx.update({
        signal: view,
        transform: (messages) => [...messages, {id: 'tmp', text: 'b'}],
        key: (message) => message.id,
      });
    });

    expect(view.peek()).toEqual([
      {id: 's1', text: 'a'},
      {id: 'tmp', text: 'b'},
    ]);
  });

  it('works on a raw reflected signal with no facade', () => {
    const {view} = reflected(1, 'hello', {raw: true});

    optimistic(undefined, (tx) => tx.set({signal: view, value: 'hello world'}));

    expect(view.peek()).toBe('hello world');
  });

  it('rolls back to the server value when the action rejects', async () => {
    const {view, push} = reflected(1, 'real');
    const action = deferred();

    optimistic(action.promise, (tx) => tx.set({signal: view, value: 'optimistic'}));
    expect(view.peek()).toBe('optimistic');

    action.reject(new Error('server said no'));
    await settle();
    expect(view.peek()).toBe('real');

    push('fresh');
    expect(view.peek()).toBe('fresh');
  });

  it('restores the server value on manual rollback without an action', () => {
    const {view} = reflected(1, 'real');

    const handle = optimistic(undefined, (tx) => tx.set({signal: view, value: 'optimistic'}));
    expect(view.peek()).toBe('optimistic');

    handle.rollback();
    expect(view.peek()).toBe('real');
  });

  it('is idempotent across rollback and a settled action', async () => {
    const {view, push} = reflected(1, 'real');
    const action = deferred();

    const handle = optimistic(action.promise, (tx) => tx.set({signal: view, value: 'optimistic'}));
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

    optimistic(new Promise<never>(() => {}), (tx) =>
      tx.update({
        signal: asReflected(loose),
        transform: (messages) => [...messages, {id: 'tmp', text: 'b'}],
        key: (message) => message.id,
      }),
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

    optimistic(action.promise, (tx) => tx.set({signal: view, value: 'v2'}));
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
      tx.update({signal: view, transform: (object) => ({...object, title: 'new'})}),
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

    optimistic(action.promise, (tx) => tx.set({signal: view, value: 'optimistic'}));
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
      tx.update({
        signal: view,
        transform: (messages) => [...messages, {id: 'tmp', text: 'b', cid: 'c1'}],
        key: (message) => message.cid ?? message.id,
      }),
    );
    expect(view.peek().map((message) => message.id)).toEqual(['s1', 'tmp']);

    // The server append confirms the insert; the patch drops in the same update.
    push([{id: 's2', text: 'b', cid: 'c1'}], 'append');
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
      tx.update({
        signal: view,
        transform: (object) => ({...object, title: 'new'}),
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
      tx.set({signal: view, value: 'optimistic', until: (server) => server === 'optimistic'}),
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
      tx.update({
        signal: view,
        transform: (messages) => [...messages, {id: 'a', text: 'A'}],
        key: (message) => message.id,
      }),
    );
    optimistic(b.promise, (tx) =>
      tx.update({
        signal: view,
        transform: (messages) => [...messages, {id: 'b', text: 'B'}],
        key: (message) => message.id,
      }),
    );
    expect(view.peek().map((message) => message.id)).toEqual(['a', 'b']);

    push([{id: 'other', text: 'O'}], 'append');
    expect(view.peek().map((message) => message.id)).toEqual([
      'a',
      'b',
      'other',
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
      tx.update({
        signal: view,
        transform: (messages) => [...messages, {id: 'a', text: 'A'}],
        key: (message) => message.id,
      }),
    );
    optimistic(b.promise, (tx) =>
      tx.update({
        signal: view,
        transform: (messages) => [...messages, {id: 'b', text: 'B'}],
        key: (message) => message.id,
      }),
    );

    opA.rollback();
    expect(view.peek().map((message) => message.id)).toEqual(['b']);
  });

  it('applies a single transaction across multiple signals', async () => {
    const list = reflected<Message[]>(1, []);
    const title = reflected(2, 'untitled');
    const action = deferred();

    optimistic(action.promise, (tx) => {
      tx.update({
        signal: list.view,
        transform: (messages) => [...messages, {id: 'x', text: 'X'}],
        key: (message) => message.id,
      });
      tx.set({signal: title.view, value: 'New Title'});
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
      tx.update({
        signal: view,
        transform: (messages) => [
          ...messages.slice(0, -1),
          {id: 'compaction', text: 'compacting…'},
          messages[messages.length - 1],
        ],
        key: (message) => message.id,
      }),
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
      tx.update({
        signal: view,
        transform: (messages) => [...messages, {id: 'tmp', text: 'b'}],
        key: (message) => message.id,
      }),
    );

    push({rogue: true}, 'merge');

    expect(view.peek().map((message) => message.id)).toEqual(['s1', 'tmp']);
  });

  it('ignores a splice delta with non-integer bounds', () => {
    const {view, push} = reflected<number[]>(1, [1, 2, 3]);
    const action = deferred();

    optimistic(action.promise, (tx) =>
      tx.update({signal: view, transform: (xs) => [...xs, 4], key: (x) => x}),
    );

    push({start: 1.5, deleteCount: 0, items: [9]}, 'splice');

    expect(view.peek()).toEqual([1, 2, 3, 4]);
  });
});

describe('optimistic — documented tradeoff of key-less reconciliation', () => {
  it('rejects keyless array inserts instead of briefly showing duplicates', () => {
    const {view, rendered, push} = reflected<Message[]>(1, [
      {id: 's1', text: 'a'},
    ]);

    expect(() =>
      optimistic(Promise.resolve(), (tx) =>
        // @ts-expect-error array updates must declare a key
        tx.update({
          signal: view,
          transform: (messages) => [...messages, {id: 'tmp', text: 'b'}],
        }),
      ),
    ).toThrow(TypeError);

    push([{id: 's2', text: 'b'}], 'append');
    expect(rendered.some((value) => value.length === 3)).toBe(false);
  });

  it('reverts to the server base when the reply precedes the delta', async () => {
    const {view, rendered, push} = reflected(1, 'untitled');
    const action = deferred();

    optimistic(action.promise, (tx) => tx.set({signal: view, value: 'Renamed'}));
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

    const handle = optimistic(undefined, (tx) => tx.set({signal: view, value: 'optimistic'}));
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
      tx.update({
        signal: facade.messages,
        transform: (messages) => [...messages, {id: 'tmp', text: 'hello'}],
        key: (message) => message.id,
      }),
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
      tx.update({
        signal: facade.messages,
        transform: (messages) => [...messages, {id: 'tmp', text: 'never'}],
        key: (message) => message.id,
      }),
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
    optimistic(action, (tx) => tx.set({signal: facade.title, value: 'Renamed'}));
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
      tx.set({signal: plain, value: 'next'});

      const text = reflected(90, 'x').view;
      // @ts-expect-error the value must match the signal's type
      tx.set({signal: text, value: 123});

      const numbers = reflected<number[]>(91, []).view;
      tx.update({
        signal: numbers,
        transform: (current) => {
          // @ts-expect-error the current value is read-only
          current.push(1);
          return [...current];
        },
        key: (number) => number,
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
      tx.update({
        signal: map,
        transform: (current) => {
          // @ts-expect-error a read-only map exposes no mutators
          current.set('x', 1);
          return new Map(current);
        },
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

describe('optimistic — robustness (never crash the read loop)', () => {
  it('drops a transform that throws on a diverged base and keeps folding', () => {
    const {view, push} = reflected<{a: {x: number}; y?: number}>(1, {a: {x: 1}});
    const errors: unknown[] = [];

    optimistic(
      new Promise<never>(() => {}),
      (tx) =>
        tx.update({
          signal: view,
          transform: (current) => ({...current, y: current.a.x}),
        }),
      {onError: (error) => errors.push(error)},
    );
    expect(view.peek()).toEqual({a: {x: 1}, y: 1});

    expect(() => push({a: null}, 'merge')).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(view.peek()).toEqual({a: null});

    push({a: {x: 9}}, 'merge');
    expect(view.peek()).toEqual({a: {x: 9}});
  });

  it('tolerates an un-keyable server row in a keyed list', () => {
    const {view, push} = reflected<Array<{id: string; sys?: boolean}>>(1, [
      {id: 'm0'},
    ]);

    optimistic(new Promise<never>(() => {}), (tx) =>
      tx.update({
        signal: view,
        transform: (rows) => [...rows, {id: 'tmp'}],
        key: (row) => row.id,
      }),
    );
    expect(view.peek().map((row) => row.id)).toEqual(['m0', 'tmp']);

    expect(() => push([{sys: true}], 'append')).not.toThrow();
    expect(view.peek()).toEqual([{id: 'm0'}, {id: 'tmp'}, {sys: true}]);
  });

  it('does not let a throwing onError escape the delta loop', () => {
    const {view, push} = reflected<{a: {x: number}; y?: number}>(1, {a: {x: 1}});

    optimistic(
      new Promise<never>(() => {}),
      (tx) =>
        tx.update({
          signal: view,
          transform: (current) => ({...current, y: current.a.x}),
        }),
      {
        onError: () => {
          throw new Error('callback blew up');
        },
      },
    );
    expect(view.peek()).toEqual({a: {x: 1}, y: 1});

    expect(() => push({a: null}, 'merge')).not.toThrow();
    expect(view.peek()).toEqual({a: null});

    push({a: {x: 9}}, 'merge');
    expect(view.peek()).toEqual({a: {x: 9}});
  });

  it('does not let a throwing onConflict escape the delta loop', () => {
    const {view, push} = reflected<Message[]>(1, [{id: 'm1', text: 'hi'}]);
    const action = deferred();
    registerCall(action.promise, 3);

    optimistic(
      action.promise,
      (tx) =>
        tx.update({
          signal: view,
          transform: (rows) => rows.map((r) => (r.id === 'm1' ? {...r, text: 'mine'} : r)),
          key: (message) => message.id,
        }),
      {
        onConflict: () => {
          throw new Error('callback blew up');
        },
      },
    );

    expect(() => push([{id: 'm1', text: 'theirs'}], undefined)).not.toThrow();
    expect(view.peek()[0].text).toBe('mine');
  });

  it('does not strand a patch when committing the optimistic value throws', () => {
    const {reflection} = new RPCClient(silentTransport);
    const source = reflection.getOrCreateSignal(1, 'server') as Signal<string>;
    const view = linkSource(source, source);
    const stop = effect(() => {
      if (view.value === 'boom') throw new Error('render effect blew up');
    });

    expect(() =>
      optimistic(undefined, (tx) => tx.set({signal: view, value: 'boom'})),
    ).toThrow('render effect blew up');

    expect(view.peek()).toBe('server');
    reflection.handleUpdate(1, 'after');
    expect(view.peek()).toBe('after');
    stop();
  });

  it('does not leak an unhandled rejection when apply throws over a rejecting action', async () => {
    const proc = (
      globalThis as unknown as {
        process: {
          on(event: string, listener: (reason: unknown) => void): void;
          off(event: string, listener: (reason: unknown) => void): void;
        };
      }
    ).process;
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    proc.on('unhandledRejection', onUnhandled);
    try {
      const {reflection} = new RPCClient(silentTransport);
      const source = reflection.getOrCreateSignal(1, 'server') as Signal<string>;
      const view = linkSource(source, source);
      const action = Promise.reject(new Error('server rejected'));

      expect(() =>
        optimistic(action, () => {
          throw new Error('apply blew up');
        }),
      ).toThrow('apply blew up');

      expect(view.peek()).toBe('server');
      await new Promise((r) => setTimeout(r, 10));
      expect(rejections).toEqual([]);
    } finally {
      proc.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects echoed combined with a non-insert keyed op', () => {
    const {view} = reflected<Message[]>(1, [{id: 'm1', text: 'hi'}]);

    expect(() =>
      optimistic(Promise.resolve(), (tx) =>
        tx.update({
          signal: view,
          transform: (rows) => rows.map((r) => (r.id === 'm1' ? {...r, text: 'x'} : r)),
          key: (message) => message.id,
          echoed: true,
        }),
      ),
    ).toThrow(TypeError);
  });
});

describe('optimistic — confirmation by mutation id', () => {
  it('confirms a scalar the server normalizes, by id, without reverting', () => {
    const {view, rendered, push} = reflected(1, 'real');
    const action = deferred();
    registerCall(action.promise, 7);

    optimistic(action.promise, (tx) => tx.set({signal: view, value: 'Draft'}));
    expect(view.peek()).toBe('Draft');

    push('DRAFT', undefined, 7);

    expect(view.peek()).toBe('DRAFT');
    expect(rendered).toEqual(['real', 'Draft', 'DRAFT']);
  });

  it('confirms a keyed replace by id even when the stored value diverges', () => {
    const {view, push} = reflected<Message[]>(1, [{id: 'm1', text: 'hi'}]);
    const action = deferred();
    registerCall(action.promise, 4);

    optimistic(action.promise, (tx) =>
      tx.update({
        signal: view,
        transform: (rows) => rows.map((r) => (r.id === 'm1' ? {...r, text: 'edited'} : r)),
        key: (message) => message.id,
      }),
    );
    expect(view.peek()[0].text).toBe('edited');

    push([{id: 'm1', text: 'EDITED (server)'}], undefined, 4);
    expect(view.peek()[0].text).toBe('EDITED (server)');

    push([{id: 'm2', text: 'q'}], 'append');
    expect(view.peek().map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('reports a concurrent write as conflict and keeps shadowing until confirmed', () => {
    const {view, push} = reflected<Message[]>(1, [{id: 'm1', text: 'hi'}]);
    const action = deferred();
    registerCall(action.promise, 9);
    const conflicts: OptimisticConflict[] = [];

    optimistic(
      action.promise,
      (tx) =>
        tx.update({
          signal: view,
          transform: (rows) =>
            rows.map((r) => (r.id === 'm1' ? {...r, text: 'mine'} : r)),
          key: (message) => message.id,
        }),
      {onConflict: (conflict) => conflicts.push(conflict)},
    );
    expect(view.peek()[0].text).toBe('mine');

    push([{id: 'm1', text: 'theirs'}], undefined);

    expect(conflicts).toEqual([{key: 'm1', optimistic: {id: 'm1', text: 'mine'}, server: {id: 'm1', text: 'theirs'}}]);
    expect(view.peek()[0].text).toBe('mine');

    push([{id: 'm1', text: 'mine'}], undefined, 9);
    expect(view.peek()[0].text).toBe('mine');
  });
});

describe('optimistic — reentrant callbacks', () => {
  it('honours a rollback issued from inside onConflict (scalar)', () => {
    const {view, rendered, push} = reflected(1, 'real');
    const action = deferred();
    registerCall(action.promise, 11);
    let handle: ReturnType<typeof optimistic> | undefined;

    handle = optimistic(action.promise, (tx) => tx.set({signal: view, value: 'mine'}), {
      onConflict: () => handle?.rollback(),
    });
    expect(view.peek()).toBe('mine');

    // A concurrent, un-tagged server write conflicts with the pending change.
    push('theirs');

    // The rollback fired from inside onConflict must win: the callback ran after
    // the fold committed, so it is not silently resurrected. Rendered value
    // tracks the server and the handle settles as rolledback, no divergence.
    expect(view.peek()).toBe('theirs');
    expect(rendered.at(-1)).toBe('theirs');
    expect(handle.state).toBe('rolledback');
  });

  it('honours a rollback issued from inside onConflict (keyed replace)', () => {
    const {view, rendered, push} = reflected<Message[]>(1, [{id: 'm1', text: 'hi'}]);
    const action = deferred();
    registerCall(action.promise, 12);
    let handle: ReturnType<typeof optimistic> | undefined;

    handle = optimistic(
      action.promise,
      (tx) =>
        tx.update({
          signal: view,
          transform: (rows) => rows.map((r) => (r.id === 'm1' ? {...r, text: 'mine'} : r)),
          key: (message) => message.id,
        }),
      {onConflict: () => handle?.rollback()},
    );
    expect(view.peek()[0].text).toBe('mine');

    push([{id: 'm1', text: 'theirs'}], undefined);

    expect(view.peek()[0].text).toBe('theirs');
    expect(rendered.at(-1)?.[0].text).toBe('theirs');
    expect(handle.state).toBe('rolledback');
  });
});

describe('optimistic — reconnect', () => {
  it('rolls the overlay back to base and fails the handle', async () => {
    const client = new RPCClient({send() {}, onMessage() {}});
    const source = client.reflection.getOrCreateSignal(1, 'server') as Signal<string>;
    const view = linkSource(
      computed(() => source.value),
      source,
    );

    const action = client.call('rename', ['optimistic']);
    const handle = optimistic(action, (tx) => tx.set({signal: view, value: 'optimistic'}));
    expect(view.peek()).toBe('optimistic');

    client.reconnect({send() {}, onMessage() {}});
    await settle();

    expect(view.peek()).toBe('server');
    expect(handle.state).toBe('failed');
  });

  it('rolls back an action-less overlay when reflection resets', () => {
    const client = new RPCClient({send() {}, onMessage() {}});
    const source = client.reflection.getOrCreateSignal(1, 'server') as Signal<string>;
    const view = linkSource(
      computed(() => source.value),
      source,
    );

    const handle = optimistic(undefined, (tx) => tx.set({signal: view, value: 'optimistic'}));
    expect(view.peek()).toBe('optimistic');

    client.reflection.reset();

    expect(view.peek()).toBe('server');
    expect(handle.state).toBe('pending');
  });
});

describe('optimistic — lifecycle observability', () => {
  it('reports settled and calls onSettle only on success', async () => {
    const {view} = reflected(1, 'real');
    const action = deferred();
    const settles: number[] = [];

    const handle = optimistic(
      action.promise,
      (tx) => tx.set({signal: view, value: 'optimistic'}),
      {onSettle: () => settles.push(1)},
    );
    expect(handle.state).toBe('pending');

    action.resolve();
    await settle();

    expect(handle.state).toBe('settled');
    expect(settles).toEqual([1]);
  });

  it('reports failed and does not call onSettle on rejection', async () => {
    const {view} = reflected(1, 'real');
    const action = deferred();
    let settled = false;

    const handle = optimistic(
      action.promise,
      (tx) => tx.set({signal: view, value: 'optimistic'}),
      {onSettle: () => (settled = true)},
    );

    action.reject(new Error('no'));
    await settle();

    expect(handle.state).toBe('failed');
    expect(settled).toBe(false);
  });

  it('reports rolledback and ignores a later settle', async () => {
    const {view} = reflected(1, 'real');
    const action = deferred();
    const settles: number[] = [];

    const handle = optimistic(
      action.promise,
      (tx) => tx.set({signal: view, value: 'optimistic'}),
      {onSettle: () => settles.push(1)},
    );

    handle.rollback();
    expect(handle.state).toBe('rolledback');

    action.resolve();
    await settle();

    // Rollback is terminal: the settle does not fire onSettle or flip state.
    expect(handle.state).toBe('rolledback');
    expect(settles).toEqual([]);
  });
});
