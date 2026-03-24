import {type Signal, signal} from '@preact/signals-core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createReflectedModel} from '../client/model.ts';
import type {WireContext} from '../client/reflection.ts';
import {RPCClient} from '../client/rpc.ts';

import {RPC} from '../server/rpc.ts';
import type {Transport} from '../shared/protocol.ts';
import {
  Counter,
  createLinkedTransportPair,
  ReflectedCounter,
} from './helpers.ts';

function connect(rpc: RPC, clientId?: string) {
  const {serverTransport, clientTransport, flush} = createLinkedTransportPair();
  const ctx = {rpc: null as any};
  const rpcClient = new RPCClient(clientTransport, ctx);
  ctx.rpc = rpcClient;
  rpcClient.registerModel('Counter', ReflectedCounter);
  const cleanup = rpc.addClient(serverTransport, clientId);
  return {rpcClient, cleanup, flush};
}

type MessageHandler = (data: {toString(): string}) => void | Promise<void>;

function createReconnectHarness(rpc: RPC, clientId = 'reconnect-client') {
  const queue: Array<() => Promise<void>> = [];
  let clientHandler: MessageHandler | undefined;
  let clientCloseHandler: ((error?: unknown) => void) | undefined;
  let clientOpenHandler: (() => void) | undefined;
  let serverHandler: MessageHandler | undefined;
  let cleanup: (() => void) | undefined;

  const enqueue = (deliver: () => void | Promise<void>) => {
    queue.push(async () => {
      await deliver();
    });
  };

  const transport: Transport = {
    send(data: string) {
      if (!serverHandler) return;
      enqueue(async () => {
        await serverHandler?.({toString: () => data});
      });
    },
    onMessage(cb) {
      clientHandler = cb;
    },
    onClose(cb) {
      clientCloseHandler = cb;
    },
    onOpen(cb) {
      clientOpenHandler = cb;
    },
  };

  return {
    transport,
    connect() {
      cleanup?.();

      let nextServerHandler: MessageHandler | undefined;
      const serverTransport: Transport = {
        send(data: string) {
          enqueue(async () => {
            await clientHandler?.({toString: () => data});
          });
        },
        onMessage(cb) {
          nextServerHandler = cb;
        },
      };

      cleanup = rpc.addClient(serverTransport, clientId);
      serverHandler = nextServerHandler;
      clientOpenHandler?.();
    },
    disconnect(error?: unknown) {
      cleanup?.();
      cleanup = undefined;
      serverHandler = undefined;
      clientCloseHandler?.(error);
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

class Project {
  id: Signal<string>;
  name: Signal<string>;

  constructor(id: string, name: string) {
    this.id = signal(id);
    this.name = signal(name);
  }

  rename(next: string) {
    this.name.value = next;
    return {ok: true};
  }
}

interface ProjectApi {
  id: Signal<string>;
  name: Signal<string>;
  rename(next: string): Promise<unknown>;
}

class TranscriptMessageItem {
  id: Signal<string>;
  role: Signal<'assistant'>;
  content: Signal<string>;
  status: Signal<string>;

  constructor(id: string, content: string) {
    this.id = signal(id);
    this.role = signal('assistant');
    this.content = signal(content);
    this.status = signal('streaming');
  }
}

class TranscriptToolCallItem {
  id: Signal<string>;
  toolCallId: Signal<string>;
  name: Signal<string>;
  args: Signal<string>;
  details: Signal<unknown | undefined>;
  output: Signal<string>;
  status: Signal<string>;

  constructor(id: string, toolCallId: string, name: string) {
    this.id = signal(id);
    this.toolCallId = signal(toolCallId);
    this.name = signal(name);
    this.args = signal('');
    this.details = signal(undefined);
    this.output = signal('');
    this.status = signal('pending');
  }
}

type TranscriptItem = TranscriptMessageItem | TranscriptToolCallItem;

class TranscriptSession {
  items = signal<TranscriptItem[]>([
    new TranscriptMessageItem('message-1', 'Hello'),
  ]);
  status = signal('running');
  _abort = 'hidden';

  finish() {
    const [message] = this.items.value;
    if (message instanceof TranscriptMessageItem) {
      message.content.value = 'Done';
      message.status.value = 'complete';
    }
    this.status.value = 'completed';
    return {ok: true};
  }
}

interface TranscriptMessageItemApi {
  id: Signal<string>;
  role: Signal<string>;
  content: Signal<string>;
  status: Signal<string>;
}

interface TranscriptToolCallItemApi {
  id: Signal<string>;
  toolCallId: Signal<string>;
  name: Signal<string>;
  args: Signal<string>;
  details: Signal<unknown | undefined>;
  output: Signal<string>;
  status: Signal<string>;
}

interface TranscriptSessionApi {
  id: Signal<string>;
  items: Signal<TranscriptItem[]>;
  status: Signal<string>;
  finish(): Promise<unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Integration: Server <-> Client', () => {
  it('client receives root model on connect', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const {rpcClient, flush} = connect(rpc, 'c1');
    await flush();
    await rpcClient.ready;

    expect(rpcClient.root).toBeDefined();
    expect(rpcClient.root.id.peek()).toBe('0');
  });

  it('client root has correct signal values', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    root.count.value = 5;
    root.name.value = 'hello';
    rpc.expose(root);

    const {rpcClient, flush} = connect(rpc, 'c1');
    await flush();
    await rpcClient.ready;

    expect(rpcClient.root.count.peek()).toBe(5);
    expect(rpcClient.root.name.peek()).toBe('hello');
  });

  it('client root has callable methods', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const {rpcClient, flush} = connect(rpc, 'c1');
    await flush();
    await rpcClient.ready;

    expect(typeof rpcClient.root.increment).toBe('function');
    expect(typeof rpcClient.root.add).toBe('function');
    expect(typeof rpcClient.root.rename).toBe('function');
  });

  it('calling root method executes on server', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const {rpcClient, flush} = connect(rpc, 'c1');
    await flush();
    await rpcClient.ready;

    const promise = rpcClient.root.increment();
    await flush();
    await promise;

    expect(root.count.peek()).toBe(1);
  });

  it('calling method with parameters', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const {rpcClient, flush} = connect(rpc, 'c1');
    await flush();
    await rpcClient.ready;

    const promise = rpcClient.root.rename('new-name');
    await flush();
    await promise;

    expect(root.name.peek()).toBe('new-name');
  });

  it('method error propagates to client', async () => {
    vi.useFakeTimers();
    const rpc = new RPC({
      fail() {
        throw new Error('server error');
      },
    });

    const {serverTransport, clientTransport, flush} =
      createLinkedTransportPair();
    const ctx = {rpc: null as any};
    const rpcClient = new RPCClient(clientTransport, ctx);
    ctx.rpc = rpcClient;
    rpc.addClient(serverTransport, 'c1');

    await flush();
    await rpcClient.ready;

    const promise = rpcClient.call('fail');
    await flush();
    await expect(promise).rejects.toThrow('server error');
  });

  it('client receives update after watch + server mutation', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const {rpcClient, flush} = connect(rpc, 'c1');
    await flush();
    await rpcClient.ready;

    rpcClient.root.count.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();

    root.count.value = 42;
    await flush();

    expect(rpcClient.root.count.peek()).toBe(42);
  });

  it('array append delta works end-to-end', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    root.items.value = ['a', 'b'];
    rpc.expose(root);

    const {rpcClient, flush} = connect(rpc, 'c1');
    await flush();
    await rpcClient.ready;

    rpcClient.root.items.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();

    root.items.value = ['a', 'b', 'c'];
    await flush();

    expect(rpcClient.root.items.peek()).toEqual(['a', 'b', 'c']);
  });

  it('string append delta works end-to-end', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    root.name.value = 'hello';
    rpc.expose(root);

    const {rpcClient, flush} = connect(rpc, 'c1');
    await flush();
    await rpcClient.ready;

    rpcClient.root.name.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();

    root.name.value = 'hello world';
    await flush();

    expect(rpcClient.root.name.peek()).toBe('hello world');
  });

  it('object merge delta works end-to-end', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    root.meta.value = {version: 1, status: 'ok'};
    rpc.expose(root);

    const {rpcClient, flush} = connect(rpc, 'c1');
    await flush();
    await rpcClient.ready;

    rpcClient.root.meta.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();

    root.meta.value = {version: 1, status: 'updated'};
    await flush();

    expect(rpcClient.root.meta.peek()).toEqual({version: 1, status: 'updated'});
  });

  it('full replacement when delta does not apply', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    root.name.value = 'abc';
    rpc.expose(root);

    const {rpcClient, flush} = connect(rpc, 'c1');
    await flush();
    await rpcClient.ready;

    rpcClient.root.name.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();

    root.name.value = 'xyz';
    await flush();

    expect(rpcClient.root.name.peek()).toBe('xyz');
  });

  it('server returns model from method -> client gets facade', async () => {
    vi.useFakeTimers();
    const child = new Counter();
    child.count.value = 99;

    const rpc = new RPC({
      getChild() {
        return child;
      },
    });
    rpc.registerModel('Counter', Counter);
    rpc.instances.register('child-1', child);

    const {rpcClient, flush} = connect(rpc, 'c1');
    await flush();
    await rpcClient.ready;

    const promise = rpcClient.call('getChild');
    await flush();
    const result = await promise;

    expect(result.id.peek()).toBe('child-1');
  });

  it('two clients get independent root serializations', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const a = connect(rpc, 'a');
    const b = connect(rpc, 'b');

    await a.flush();
    await a.rpcClient.ready;
    await b.flush();
    await b.rpcClient.ready;

    expect(a.rpcClient.root).toBeDefined();
    expect(b.rpcClient.root).toBeDefined();
    expect(a.rpcClient.root).not.toBe(b.rpcClient.root);
  });

  it('signal update sent to both subscribed clients', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const a = connect(rpc, 'a');
    const b = connect(rpc, 'b');

    await a.flush();
    await a.rpcClient.ready;
    await b.flush();
    await b.rpcClient.ready;

    a.rpcClient.root.count.subscribe(() => undefined);
    b.rpcClient.root.count.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await a.flush();
    await b.flush();

    root.count.value = 77;
    await a.flush();
    await b.flush();

    expect(a.rpcClient.root.count.peek()).toBe(77);
    expect(b.rpcClient.root.count.peek()).toBe(77);
  });

  it('client disconnect cleans up subscriptions', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const a = connect(rpc, 'a');
    const b = connect(rpc, 'b');

    await a.flush();
    await a.rpcClient.ready;
    await b.flush();
    await b.rpcClient.ready;

    const stopA = a.rpcClient.root.count.subscribe(() => undefined);
    b.rpcClient.root.count.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await a.flush();
    await b.flush();

    stopA();
    a.cleanup();

    root.count.value = 50;
    await b.flush();

    expect(b.rpcClient.root.count.peek()).toBe(50);
  });

  it('cleanup function stops client from receiving messages', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const {rpcClient, cleanup, flush} = connect(rpc, 'c1');
    await flush();
    await rpcClient.ready;

    rpcClient.root.count.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();

    root.count.value = 10;
    await flush();

    expect(rpcClient.root.count.peek()).toBe(10);

    cleanup();

    root.count.value = 999;
    await flush();

    expect(rpcClient.root.count.peek()).toBe(10);
  });

  it('replays active signal subscriptions after reconnect', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const harness = createReconnectHarness(rpc, 'reconnect-1');
    const ctx = {rpc: null as any};
    const client = new RPCClient(harness.transport, ctx);
    ctx.rpc = client;
    client.registerModel('Counter', ReflectedCounter);

    harness.connect();
    await harness.flush();
    await client.ready;

    const stop = client.root.count.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await harness.flush();

    root.count.value = 10;
    await harness.flush();
    expect(client.root.count.peek()).toBe(10);

    harness.disconnect();

    root.count.value = 20;
    await harness.flush();
    expect(client.root.count.peek()).toBe(10);

    harness.connect();
    await harness.flush();

    expect(client.root.count.peek()).toBe(20);

    root.count.value = 30;
    await harness.flush();

    expect(client.root.count.peek()).toBe(30);
    stop();
  });

  it('restores reflected model method calls after reconnect', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const harness = createReconnectHarness(rpc, 'reconnect-2');
    const ctx = {rpc: null as any};
    const client = new RPCClient(harness.transport, ctx);
    ctx.rpc = client;
    client.registerModel('Counter', ReflectedCounter);

    harness.connect();
    await harness.flush();
    await client.ready;

    const first = client.root.increment();
    await harness.flush();
    await first;
    expect(root.count.peek()).toBe(1);

    harness.disconnect();
    harness.connect();
    await harness.flush();

    const second = client.root.increment();
    await harness.flush();
    await second;

    expect(root.count.peek()).toBe(2);
  });

  it('rpc.call from client still works with method routing', async () => {
    vi.useFakeTimers();
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const {rpcClient, flush} = connect(rpc, 'c1');
    await flush();
    await rpcClient.ready;

    const p1 = rpcClient.call('increment');
    await flush();
    await p1;

    const p2 = rpcClient.call('increment');
    await flush();
    await p2;

    expect(root.count.peek()).toBe(2);
  });
});

describe('mixed-signals roundtrip', () => {
  it('round-trips roots, shared signals, model facades, and live updates', async () => {
    vi.useFakeTimers();

    const title = signal('Hello');
    const project = new Project('42', 'Initial');
    const rpc = new RPC({title, alias: title, project});
    const {serverTransport, clientTransport, flush} =
      createLinkedTransportPair();
    const ProjectModel = createReflectedModel<ProjectApi>(
      ['id', 'name'],
      ['rename'],
    );
    let client!: RPCClient;

    rpc.registerModel('Project', Project);

    const ctx: WireContext = {
      get rpc() {
        return client;
      },
    };

    client = new RPCClient(clientTransport, ctx);
    client.registerModel('Project', ProjectModel);

    rpc.addClient(serverTransport, 'client-1');
    await flush();
    await client.ready;

    expect(client.root.title.value).toBe('Hello');
    expect(client.root.title).toBe(client.root.alias);
    expect(client.root.project.id.value).toBe('42');
    expect(client.root.project.name.value).toBe('Initial');
    expect(typeof client.root.project.rename).toBe('function');

    const stopTitle = client.root.title.subscribe(() => undefined);
    const stopProjectName = client.root.project.name.subscribe(() => undefined);

    vi.advanceTimersByTime(1);
    await flush();

    title.value = 'World';
    await flush();

    expect(client.root.title.value).toBe('World');
    expect(client.root.alias.value).toBe('World');

    const rename = client.root.project.rename('Renamed');

    await flush();
    await expect(rename).resolves.toEqual({ok: true});
    expect(client.root.project.name.value).toBe('Renamed');

    project.name.value = 'Again';
    await flush();

    expect(client.root.project.name.value).toBe('Again');

    stopTitle();
    stopProjectName();
  });

  it('round-trips reflected models with nested signal-backed timeline items', async () => {
    vi.useFakeTimers();

    const session = new TranscriptSession();
    const rpc = new RPC({session});
    const {serverTransport, clientTransport, flush} =
      createLinkedTransportPair();
    const SessionModel = createReflectedModel<TranscriptSessionApi>(
      ['items', 'status'],
      ['finish'],
    );
    const TranscriptMessageModel =
      createReflectedModel<TranscriptMessageItemApi>(
        ['id', 'role', 'content', 'status'],
        [],
      );
    const TranscriptToolCallModel =
      createReflectedModel<TranscriptToolCallItemApi>(
        ['id', 'toolCallId', 'name', 'args', 'details', 'output', 'status'],
        [],
      );

    rpc.registerModel('TranscriptSession', TranscriptSession);
    rpc.registerModel('TranscriptMessageItem', TranscriptMessageItem);
    rpc.registerModel('TranscriptToolCallItem', TranscriptToolCallItem);

    const client = new RPCClient(clientTransport);
    client.registerModel('TranscriptSession', SessionModel);
    client.registerModel('TranscriptMessageItem', TranscriptMessageModel);
    client.registerModel('TranscriptToolCallItem', TranscriptToolCallModel);

    rpc.addClient(serverTransport, 'client-1');
    await flush();
    await client.ready;

    expect(client.root.session.status.value).toBe('running');
    expect(client.root.session.items.value[0].content.value).toBe('Hello');
    expect(client.root.session).not.toHaveProperty('_abort');

    const stopItems = client.root.session.items.subscribe(() => undefined);
    const stopStatus = client.root.session.status.subscribe(() => undefined);
    const firstServerItem = session.items.value[0];
    if (!(firstServerItem instanceof TranscriptMessageItem)) {
      throw new Error('Expected the first server item to be a message');
    }
    const stopContent = client.root.session.items.value[0].content.subscribe(
      () => undefined,
    );
    const stopMessageStatus =
      client.root.session.items.value[0].status.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();

    firstServerItem.content.value = 'Hello world';
    await flush();
    expect(client.root.session.items.value[0].content.value).toBe(
      'Hello world',
    );

    const toolCall = new TranscriptToolCallItem(
      'tool-1',
      'tool-call-1',
      'read',
    );
    toolCall.args.value = '{"path":"index.ts"}';
    toolCall.output.value = 'Reading...';
    toolCall.status.value = 'streaming';
    session.items.value = [...session.items.value, toolCall];
    await flush();

    expect(client.root.session.items.value[1].name.value).toBe('read');
    expect(client.root.session.items.value[1].output.value).toBe('Reading...');

    toolCall.output.value = 'file contents';
    toolCall.status.value = 'complete';
    await flush();

    expect(client.root.session.items.value[1].output.value).toBe(
      'file contents',
    );
    expect(client.root.session.items.value[1].status.value).toBe('complete');

    const finish = client.root.session.finish();
    await flush();
    await expect(finish).resolves.toEqual({ok: true});

    const firstItem = client.root.session.items.value[0];
    if (!('role' in firstItem)) {
      throw new Error('Expected the first session item to be a message');
    }
    expect(firstItem.content.value).toBe('Done');
    expect(firstItem.status.value).toBe('complete');
    expect(client.root.session.status.value).toBe('completed');

    stopContent?.();
    stopMessageStatus();
    stopItems();
    stopStatus();
  });
});
