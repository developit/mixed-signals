import {type Signal, signal} from '@preact/signals-core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createReflectedModel} from '../../client/model.ts';
import type {WireContext} from '../../client/reflection.ts';
import {RPCClient} from '../../client/rpc.ts';
import {addPrefix, stripPrefix} from '../../server/forwarding.ts';
import {createModel} from '../../server/model.ts';
import {RPC} from '../../server/rpc.ts';
import type {Transport} from '../../shared/protocol.ts';

type MessageHandler = (data: {toString(): string}) => void | Promise<void>;

/**
 * Creates a triplet of linked transports for testing the three-hop chain:
 *   Broker RPC ←→ Server RPC ←→ Browser RPCClient
 *
 * Uses a synchronous queue with explicit flush() for deterministic tests.
 */
function createLinkedTransports(): {
  brokerTransport: Transport;
  serverUpstreamTransport: Transport;
  serverDownstreamTransport: Transport;
  browserTransport: Transport;
  flush: () => Promise<void>;
} {
  const queue: Array<() => Promise<void>> = [];

  // Late-binding: handlers are resolved at delivery time, not enqueue time.
  // This avoids message loss when send() is called before onMessage() registers a handler.
  const handlers: Record<string, MessageHandler | undefined> = {};
  const enqueue = (key: string, data: string) => {
    queue.push(async () => {
      await handlers[key]?.({toString: () => data});
    });
  };

  return {
    // Broker's view of the server connection
    brokerTransport: {
      send(data: string) {
        enqueue('serverUpstream', data);
      },
      onMessage(cb) {
        handlers.broker = cb;
      },
    },
    // Server's upstream (to broker)
    serverUpstreamTransport: {
      send(data: string) {
        enqueue('broker', data);
      },
      onMessage(cb) {
        handlers.serverUpstream = cb;
      },
    },
    // Server's downstream (to browser)
    serverDownstreamTransport: {
      send(data: string) {
        enqueue('browser', data);
      },
      onMessage(cb) {
        handlers.serverDownstream = cb;
      },
    },
    // Browser's view
    browserTransport: {
      send(data: string) {
        enqueue('serverDownstream', data);
      },
      onMessage(cb) {
        handlers.browser = cb;
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

// --- Broker-side models (real implementations with signals) ---

class BrokerProject {
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

class BrokerSessions {
  status = signal('ready');
  sessions = signal<BrokerSession[]>([]);

  createSession() {
    const session = new BrokerSession(
      `session-${this.sessions.value.length + 1}`,
    );
    this.sessions.value = [...this.sessions.value, session];
    return session;
  }
}

class BrokerSession {
  id: Signal<string>;
  messages = signal<BrokerMessage[]>([]);
  status = signal('idle');

  constructor(id: string) {
    this.id = signal(id);
  }

  submit(text: string) {
    const msg = new BrokerMessage(
      `msg-${this.messages.value.length + 1}`,
      'user',
      text,
    );
    this.messages.value = [...this.messages.value, msg];
    this.status.value = 'running';
    return {ok: true};
  }

  stop() {
    this.status.value = 'idle';
  }
}

class BrokerMessage {
  id: Signal<string>;
  role: Signal<string>;
  content: Signal<string>;
  status: Signal<string>;

  constructor(id: string, role: string, content: string) {
    this.id = signal(id);
    this.role = signal(role);
    this.content = signal(content);
    this.status = signal('complete');
  }
}

// --- Browser-side reflected models ---

interface ProjectApi {
  id: Signal<string>;
  name: Signal<string>;
  rename(next: string): Promise<{ok: boolean}>;
}

interface SessionsApi {
  id: Signal<string>;
  status: Signal<string>;
  sessions: Signal<any[]>;
  createSession(): Promise<any>;
}

interface SessionApi {
  id: Signal<string>;
  messages: Signal<any[]>;
  status: Signal<string>;
  submit(text: string): Promise<{ok: boolean}>;
  stop(): Promise<void>;
}

interface MessageApi {
  id: Signal<string>;
  role: Signal<string>;
  content: Signal<string>;
  status: Signal<string>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('addPrefix / stripPrefix', () => {
  it('prefixes @S and @M markers', () => {
    const input = {
      '@M': 'Sessions#0',
      status: {'@S': 1, v: 'ready'},
      sessions: {'@S': 2, v: []},
    };

    const prefixed = addPrefix('1', input);

    expect(prefixed).toEqual({
      '@M': 'Sessions#1_0',
      status: {'@S': '1_1', v: 'ready'},
      sessions: {'@S': '1_2', v: []},
    });
  });

  it('handles nested arrays with models', () => {
    const input = [{'@M': 'Session#3', status: {'@S': 5, v: 'idle'}}];
    const prefixed = addPrefix('2', input);

    expect(prefixed).toEqual([
      {'@M': 'Session#2_3', status: {'@S': '2_5', v: 'idle'}},
    ]);
  });

  it('stripPrefix reverses addPrefix', () => {
    const original = {
      '@M': 'Sessions#0',
      nested: {'@S': 42, v: [{'@M': 'Item#7'}]},
    };

    const prefixed = addPrefix('1', original);
    const stripped = stripPrefix('1', prefixed);

    expect(stripped).toEqual(original);
  });

  it('passes through non-prefixed values', () => {
    expect(addPrefix('1', 'hello')).toBe('hello');
    expect(addPrefix('1', 42)).toBe(42);
    expect(addPrefix('1', null)).toBeNull();
    expect(addPrefix('1', {foo: 'bar'})).toEqual({foo: 'bar'});
  });
});

describe('protocol-level forwarding', () => {
  it('forwards root, signal updates, and method calls through the server', async () => {
    vi.useFakeTimers();

    const {
      brokerTransport,
      serverUpstreamTransport,
      serverDownstreamTransport,
      browserTransport,
      flush,
    } = createLinkedTransports();

    // --- Broker setup ---
    const brokerRpc = new RPC();
    brokerRpc.registerModel('BrokerProject', BrokerProject);
    const project = new BrokerProject('42', 'Initial');
    brokerRpc.expose({project});
    brokerRpc.addClient(brokerTransport);

    // --- Server setup (pure forwarding, no models) ---
    const serverRpc = new RPC();
    serverRpc.addUpstream(serverUpstreamTransport);

    // Flush to deliver @R from broker → server
    await flush();

    // --- Browser setup ---
    const ProjectModel = createReflectedModel<ProjectApi>(
      ['id', 'name'],
      ['rename'],
    );
    let browser!: RPCClient;
    const ctx: WireContext = {
      rpc: {call: (m, p) => browser.call(m, p)},
    };
    browser = new RPCClient(browserTransport, ctx);
    browser.reflection.registerModel('BrokerProject', ProjectModel);

    serverRpc.addClient(serverDownstreamTransport, 'browser-1');

    // Flush to deliver @R from server → browser
    await flush();
    await browser.ready;

    // Verify root arrived with prefixed IDs
    expect(browser.root.project).toBeDefined();
    expect(browser.root.project.id.value).toBe('42');
    expect(browser.root.project.name.value).toBe('Initial');

    // Subscribe to signals
    const stopName = browser.root.project.name.subscribe(() => {});
    vi.advanceTimersByTime(1);
    await flush();

    // --- Signal update flows through ---
    project.name.value = 'Updated';
    await flush();

    expect(browser.root.project.name.value).toBe('Updated');

    // --- Method call flows through ---
    const renamePromise = browser.root.project.rename('Renamed');
    await flush();
    await expect(renamePromise).resolves.toEqual({ok: true});

    // Method side-effect: name updated on broker
    expect(project.name.value).toBe('Renamed');

    // Signal update from method arrives
    await flush();
    expect(browser.root.project.name.value).toBe('Renamed');

    stopName();
  });

  it('forwards method results containing new model instances', async () => {
    vi.useFakeTimers();

    const {
      brokerTransport,
      serverUpstreamTransport,
      serverDownstreamTransport,
      browserTransport,
      flush,
    } = createLinkedTransports();

    // --- Broker ---
    const brokerRpc = new RPC();
    brokerRpc.registerModel('BrokerSessions', BrokerSessions);
    brokerRpc.registerModel('BrokerSession', BrokerSession);
    brokerRpc.registerModel('BrokerMessage', BrokerMessage);

    const sessions = new BrokerSessions();
    brokerRpc.expose({sessions});
    brokerRpc.addClient(brokerTransport);

    // --- Server (forwarding only) ---
    const serverRpc = new RPC();
    serverRpc.addUpstream(serverUpstreamTransport);
    await flush();

    // --- Browser ---
    const SessionsModel = createReflectedModel<SessionsApi>(
      ['status', 'sessions'],
      ['createSession'],
    );
    const SessionModel = createReflectedModel<SessionApi>(
      ['messages', 'status'],
      ['submit', 'stop'],
    );
    const MessageModel = createReflectedModel<MessageApi>(
      ['id', 'role', 'content', 'status'],
      [],
    );

    let browser!: RPCClient;
    const ctx: WireContext = {
      rpc: {call: (m, p) => browser.call(m, p)},
    };
    browser = new RPCClient(browserTransport, ctx);
    browser.reflection.registerModel('BrokerSessions', SessionsModel);
    browser.reflection.registerModel('BrokerSession', SessionModel);
    browser.reflection.registerModel('BrokerMessage', MessageModel);

    serverRpc.addClient(serverDownstreamTransport, 'browser-1');
    await flush();
    await browser.ready;

    expect(browser.root.sessions.status.value).toBe('ready');

    // Subscribe to sessions list
    const stopSessions = browser.root.sessions.sessions.subscribe(() => {});
    vi.advanceTimersByTime(1);
    await flush();

    // --- Create a session (method returns a new model) ---
    const createPromise = browser.root.sessions.createSession();
    await flush();
    const created = await createPromise;

    expect(created).toBeDefined();
    expect(created.status.value).toBe('idle');

    // Subscribe to the new session's messages and status
    const stopMessages = created.messages.subscribe(() => {});
    const stopStatus = created.status.subscribe(() => {});
    vi.advanceTimersByTime(1);
    await flush();

    // --- Submit a message ---
    const submitPromise = created.submit('Hello');
    await flush();
    await expect(submitPromise).resolves.toEqual({ok: true});

    // Signal update: status and messages should reflect
    await flush();

    expect(created.status.value).toBe('running');
    expect(created.messages.value).toHaveLength(1);
    expect(created.messages.value[0].content.value).toBe('Hello');

    stopSessions();
    stopMessages();
    stopStatus();
  });

  it('handles streaming text via delta append', async () => {
    vi.useFakeTimers();

    const {
      brokerTransport,
      serverUpstreamTransport,
      serverDownstreamTransport,
      browserTransport,
      flush,
    } = createLinkedTransports();

    // Broker with a simple streaming model
    const brokerRpc = new RPC();
    const StreamModel = createModel(() => ({
      content: signal(''),
    }));
    brokerRpc.registerModel('Stream', StreamModel);
    const stream = new StreamModel();
    brokerRpc.expose({stream});
    brokerRpc.addClient(brokerTransport);

    // Server
    const serverRpc = new RPC();
    serverRpc.addUpstream(serverUpstreamTransport);
    await flush();

    // Browser
    const ClientStreamModel = createReflectedModel<{
      id: Signal<string>;
      content: Signal<string>;
    }>(['content'], []);
    let browser!: RPCClient;
    const ctx: WireContext = {rpc: {call: (m, p) => browser.call(m, p)}};
    browser = new RPCClient(browserTransport, ctx);
    browser.reflection.registerModel('Stream', ClientStreamModel);

    serverRpc.addClient(serverDownstreamTransport, 'browser-1');
    await flush();
    await browser.ready;

    // Subscribe to content
    const stopContent = browser.root.stream.content.subscribe(() => {});
    vi.advanceTimersByTime(1);
    await flush();

    // Stream text in chunks
    stream.content.value = 'Hello';
    await flush();
    expect(browser.root.stream.content.value).toBe('Hello');

    stream.content.value = 'Hello world';
    await flush();
    expect(browser.root.stream.content.value).toBe('Hello world');

    stream.content.value = 'Hello world!';
    await flush();
    expect(browser.root.stream.content.value).toBe('Hello world!');

    stopContent();
  });

  it('mixes local and forwarded models', async () => {
    vi.useFakeTimers();

    const {
      brokerTransport,
      serverUpstreamTransport,
      serverDownstreamTransport,
      browserTransport,
      flush,
    } = createLinkedTransports();

    // Broker
    const brokerRpc = new RPC();
    const RemoteModel = createModel((value: string) => ({
      value: signal(value),
    }));
    brokerRpc.registerModel('Remote', RemoteModel);
    const remote = new RemoteModel('from-broker');
    brokerRpc.expose({remote});
    brokerRpc.addClient(brokerTransport);

    // Server with a LOCAL model and an upstream
    const serverRpc = new RPC();
    const LocalModel = createModel((value: string) => ({
      value: signal(value),
    }));
    serverRpc.registerModel('Local', LocalModel);
    const local = new LocalModel('from-server');
    serverRpc.expose({local});
    serverRpc.addUpstream(serverUpstreamTransport);
    await flush();

    // Browser
    const ClientLocalModel = createReflectedModel<{
      id: Signal<string>;
      value: Signal<string>;
    }>(['value'], []);
    const ClientRemoteModel = createReflectedModel<{
      id: Signal<string>;
      value: Signal<string>;
    }>(['value'], []);
    let browser!: RPCClient;
    const ctx: WireContext = {rpc: {call: (m, p) => browser.call(m, p)}};
    browser = new RPCClient(browserTransport, ctx);
    browser.reflection.registerModel('Local', ClientLocalModel);
    browser.reflection.registerModel('Remote', ClientRemoteModel);

    serverRpc.addClient(serverDownstreamTransport, 'browser-1');
    await flush();
    await browser.ready;

    // Both models should be accessible from the root
    expect(browser.root.local.value.value).toBe('from-server');
    expect(browser.root.remote.value.value).toBe('from-broker');

    // Subscribe to both
    const stopLocal = browser.root.local.value.subscribe(() => {});
    const stopRemote = browser.root.remote.value.subscribe(() => {});
    vi.advanceTimersByTime(1);
    await flush();

    // Update local model
    local.value.value = 'updated-server';
    await flush();
    expect(browser.root.local.value.value).toBe('updated-server');

    // Update remote model
    remote.value.value = 'updated-broker';
    await flush();
    expect(browser.root.remote.value.value).toBe('updated-broker');

    stopLocal();
    stopRemote();
  });
});
