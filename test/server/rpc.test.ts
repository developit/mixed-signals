import {signal} from '@preact/signals-core';
import {describe, expect, it} from 'vitest';
import {RPC} from '../../server/rpc.ts';
import {
  formatCallMessage,
  formatNotificationMessage,
  parseWireMessage,
  parseWireParams,
  parseWireValue,
  ROOT_NOTIFICATION_METHOD,
  SIGNAL_UPDATE_METHOD,
  type Transport,
  UNWATCH_SIGNALS_METHOD,
  WATCH_SIGNALS_METHOD,
} from '../../shared/protocol.ts';
import {Counter} from '../helpers.ts';

type MessageHandler = (data: {toString(): string}) => void | Promise<void>;

class FakeTransport implements Transport {
  sent: string[] = [];
  private handler?: MessageHandler;
  send(data: string) {
    this.sent.push(data);
  }
  onMessage(cb: (data: {toString(): string}) => void) {
    this.handler = cb;
  }
  async emit(data: string) {
    await this.handler?.({toString: () => data});
  }
}

function parseNotification(message: string): {
  method: string;
  params: unknown[];
} {
  const parsed = parseWireMessage(message);
  expect(parsed?.type).toBe('notification');
  if (!parsed || parsed.type !== 'notification')
    throw new Error('Expected a notification');
  return {method: parsed.method, params: parseWireParams(parsed.payload)};
}

describe('RPC', () => {
  it('sends the reflected root when a client connects', () => {
    const rpc = new RPC({count: signal(1)});
    const transport = new FakeTransport();
    rpc.addClient(transport);

    expect(transport.sent).toHaveLength(1);
    const notification = parseNotification(transport.sent[0]);
    expect(notification.method).toBe(ROOT_NOTIFICATION_METHOD);
    const root = notification.params[0] as Record<string, any>;
    expect(root.count).toMatchObject({'@S': expect.any(Number), v: 1});
  });

  it('registers root instance at id 0', () => {
    const rpc = new RPC();
    const root = new Counter();
    rpc.expose(root);
    expect(rpc.instances.get('0')).toBe(root);
  });

  it('sends serialized root to client on addClient', () => {
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const sent: string[] = [];
    const transport = new FakeTransport();
    transport.send = (data: string) => sent.push(data);
    rpc.addClient(transport);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^N:@R:/);
    const payload = parseWireParams(sent[0].slice('N:@R:'.length));
    expect((payload[0] as any)['@M']).toBe('Counter#0');
  });

  it('addClient returns cleanup function', () => {
    const rpc = new RPC();
    const cleanup = rpc.addClient(new FakeTransport());
    expect(typeof cleanup).toBe('function');
  });

  it('cleanup stops message delivery', () => {
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const sent: string[] = [];
    const transport = new FakeTransport();
    transport.send = (data: string) => sent.push(data);
    const cleanup = rpc.addClient(transport);
    sent.length = 0;

    cleanup();
    rpc.notify('test', ['data']);
    expect(sent).toHaveLength(0);
  });

  it('routes nested root methods and returns results', async () => {
    class Sessions {
      prefix = 'session';
      createSession(name: string) {
        return {name: `${this.prefix}:${name}`};
      }
    }

    const rpc = new RPC({sessions: new Sessions()});
    const transport = new FakeTransport();
    rpc.addClient(transport);
    transport.sent.length = 0;

    await transport.emit(
      formatCallMessage(1, 'sessions.createSession', ['alpha']),
    );

    expect(transport.sent).toHaveLength(1);
    const result = parseWireMessage(transport.sent[0]);
    expect(result?.type).toBe('result');
    if (result?.type === 'result') {
      expect(parseWireValue(result.payload)).toEqual({name: 'session:alpha'});
    }
  });

  it('routes instance methods through wire ids', async () => {
    const rpc = new RPC({});

    class Todo {
      done = false;
      toggle() {
        this.done = !this.done;
        return {done: this.done};
      }
    }

    rpc.instances.register('42', new Todo());
    const transport = new FakeTransport();
    rpc.addClient(transport);
    transport.sent.length = 0;

    await transport.emit(formatCallMessage(1, '42#toggle', []));

    expect(transport.sent).toHaveLength(1);
    const result = parseWireMessage(transport.sent[0]);
    expect(result?.type).toBe('result');
    if (result?.type === 'result') {
      expect(parseWireValue(result.payload)).toEqual({done: true});
    }
  });

  it('returns error frames for missing instances and methods', async () => {
    const rpc = new RPC({sessions: {}});
    const transport = new FakeTransport();
    rpc.addClient(transport);
    transport.sent.length = 0;

    await transport.emit(formatCallMessage(1, '99#toggle', []));
    const error1 = parseWireMessage(transport.sent[0]);
    expect(error1?.type).toBe('error');
    if (error1?.type === 'error') {
      expect(parseWireValue<any>(error1.payload).message).toMatch(
        'Instance not found: 99',
      );
    }

    await transport.emit(formatCallMessage(2, 'sessions.missing', []));
    const error2 = parseWireMessage(transport.sent[1]);
    expect(error2?.type).toBe('error');
    if (error2?.type === 'error') {
      expect(parseWireValue<any>(error2.payload).message).toMatch(
        'Method not found: sessions.missing',
      );
    }
  });

  it('method call on root returns result', async () => {
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const sent: string[] = [];
    const transport = new FakeTransport();
    transport.send = (data: string) => sent.push(data);
    rpc.addClient(transport);
    sent.length = 0;

    await transport.emit('M1:increment:');
    await new Promise((r) => setTimeout(r, 10));

    const response = sent.find((m) => m.startsWith('R1:'));
    expect(response).toBeDefined();
  });

  it('instance method via id#method syntax', async () => {
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const child = new Counter();
    rpc.instances.register('99', child);

    const transport = new FakeTransport();
    rpc.addClient(transport);
    transport.sent.length = 0;

    await transport.emit('M2:99#increment:');
    await new Promise((r) => setTimeout(r, 10));

    expect(child.count.peek()).toBe(1);
    const response = transport.sent.find((m) => m.startsWith('R2:'));
    expect(response).toBeDefined();
  });

  it('unknown instance returns error', async () => {
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const transport = new FakeTransport();
    rpc.addClient(transport);
    transport.sent.length = 0;

    await transport.emit('M3:unknown#method:');
    await new Promise((r) => setTimeout(r, 10));

    const response = transport.sent.find((m) => m.startsWith('E3:'));
    expect(response).toBeDefined();
    expect(response).toMatch('Instance not found');
  });

  it('non-function method returns error', async () => {
    const rpc = new RPC({notAMethod: 42});
    const transport = new FakeTransport();
    rpc.addClient(transport);
    transport.sent.length = 0;

    await transport.emit('M4:notAMethod:');
    await new Promise((r) => setTimeout(r, 10));

    const response = transport.sent.find((m) => m.startsWith('E4:'));
    expect(response).toBeDefined();
    expect(response).toMatch('Method not found');
  });

  it('dot notation for nested property access', async () => {
    const rpc = new RPC({
      nested: {
        deep: {
          greet() {
            return 'hi';
          },
        },
      },
    });
    const transport = new FakeTransport();
    rpc.addClient(transport);
    transport.sent.length = 0;

    await transport.emit('M5:nested.deep.greet:');
    await new Promise((r) => setTimeout(r, 10));

    const response = transport.sent.find((m) => m.startsWith('R5:'));
    expect(response).toBeDefined();
    expect(response).toMatch('hi');
  });

  it('@W message calls reflection watch', async () => {
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const transport = new FakeTransport();
    rpc.addClient(transport);

    await transport.emit('N:@W:1,2,3');
  });

  it('@U message calls reflection unwatch', async () => {
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const transport = new FakeTransport();
    rpc.addClient(transport);

    await transport.emit('N:@U:1,2');
  });

  it('method with parameters', async () => {
    const rpc = new RPC();
    rpc.registerModel('Counter', Counter);
    const root = new Counter();
    rpc.expose(root);

    const transport = new FakeTransport();
    rpc.addClient(transport);
    transport.sent.length = 0;

    await transport.emit('M6:rename:"new-name"');
    await new Promise((r) => setTimeout(r, 10));

    expect(root.name.peek()).toBe('new-name');
  });

  it('routes watch and unwatch and sends deltas', async () => {
    const count = signal(1);
    const rpc = new RPC({count});
    const transport = new FakeTransport();
    rpc.addClient(transport);

    // Parse the root notification to find the signal ID for count
    const rootNotification = parseNotification(transport.sent[0]);
    const rootObj = rootNotification.params[0] as Record<string, any>;
    const signalId = rootObj.count['@S'];
    expect(signalId).toBeTypeOf('number');

    transport.sent.length = 0;

    // Watch the signal
    await transport.emit(
      formatNotificationMessage(WATCH_SIGNALS_METHOD, [signalId]),
    );

    // Mutate the signal
    count.value = 2;

    // Should have received a delta
    expect(transport.sent).toHaveLength(1);
    const update = parseNotification(transport.sent[0]);
    expect(update.method).toBe(SIGNAL_UPDATE_METHOD);
    expect(update.params).toEqual([signalId, 2]);

    transport.sent.length = 0;

    // Unwatch the signal
    await transport.emit(
      formatNotificationMessage(UNWATCH_SIGNALS_METHOD, [signalId]),
    );

    // Mutate the signal again
    count.value = 3;

    // Should not have received anything
    expect(transport.sent).toHaveLength(0);
  });

  it('sends notification to specific client', () => {
    const rpc = new RPC();

    const sentA: string[] = [];
    const transportA = new FakeTransport();
    transportA.send = (data: string) => sentA.push(data);

    const sentB: string[] = [];
    const transportB = new FakeTransport();
    transportB.send = (data: string) => sentB.push(data);

    rpc.addClient(transportA, 'a');
    rpc.addClient(transportB, 'b');

    rpc.notify('hello', ['world'], 'a');

    expect(sentA).toHaveLength(1);
    const notification = parseNotification(sentA[0]);
    expect(notification.method).toBe('hello');
    expect(sentB).toHaveLength(0);
  });

  it('broadcasts to all clients when no clientId', () => {
    const rpc = new RPC();

    const sentA: string[] = [];
    const transportA = new FakeTransport();
    transportA.send = (data: string) => sentA.push(data);

    const sentB: string[] = [];
    const transportB = new FakeTransport();
    transportB.send = (data: string) => sentB.push(data);

    rpc.addClient(transportA, 'a');
    rpc.addClient(transportB, 'b');

    rpc.notify('ping', [42]);

    expect(sentA).toHaveLength(1);
    expect(sentB).toHaveLength(1);
  });

  it('send passes string messages through', () => {
    const rpc = new RPC();
    const transport = new FakeTransport();
    rpc.addClient(transport, 'c1');

    rpc.send('c1', 'raw-message');
    expect(transport.sent[transport.sent.length - 1]).toBe('raw-message');
  });

  it('send is no-op for unknown client', () => {
    const rpc = new RPC();
    rpc.send('nonexistent', 'test');
  });
});
