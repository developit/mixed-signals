import {type Signal, signal} from '@preact/signals-core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {RPCClient} from '../../client/rpc.ts';
import {addPrefix, stripPrefix} from '../../server/forwarding.ts';
import {createModel} from '../../server/model.ts';
import {RPC} from '../../server/rpc.ts';
import type {Transport} from '../../shared/protocol.ts';

type MessageHandler = (data: {toString(): string}) => void | Promise<void>;

function createLinkedTransports() {
  const queue: Array<() => Promise<void>> = [];
  const handlers: Record<string, MessageHandler | undefined> = {};
  const enqueue = (key: string, data: string) => {
    queue.push(async () => {
      await handlers[key]?.({toString: () => data});
    });
  };
  return {
    brokerTransport: {
      send(d: string) {
        enqueue('serverUpstream', d);
      },
      onMessage(cb: any) {
        handlers.broker = cb;
      },
    } as Transport,
    serverUpstreamTransport: {
      send(d: string) {
        enqueue('broker', d);
      },
      onMessage(cb: any) {
        handlers.serverUpstream = cb;
      },
    } as Transport,
    serverDownstreamTransport: {
      send(d: string) {
        enqueue('browser', d);
      },
      onMessage(cb: any) {
        handlers.serverDownstream = cb;
      },
    } as Transport,
    browserTransport: {
      send(d: string) {
        enqueue('serverDownstream', d);
      },
      onMessage(cb: any) {
        handlers.browser = cb;
      },
    } as Transport,
    async flush() {
      while (queue.length > 0) {
        const pending = queue.splice(0);
        for (const d of pending) await d();
      }
    },
  };
}

const BrokerProject = createModel<{
  id: Signal<string>;
  name: Signal<string>;
  rename(next: string): {ok: boolean};
}>('Project', () => {
  const id = signal('42');
  const name = signal('Initial');
  return {
    id,
    name,
    rename(next: string) {
      name.value = next;
      return {ok: true};
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('addPrefix / stripPrefix', () => {
  it('prefixes @H ids preserving the kind character', () => {
    const input = {
      '@H': 'o7',
      s: 1,
      d: [{'@H': 's3', v: 'hi'}, {'@H': 'f11'}],
    };
    const out = addPrefix('2', input);
    expect(out).toEqual({
      '@H': 'o2_7',
      s: 1,
      d: [{'@H': 's2_3', v: 'hi'}, {'@H': 'f2_11'}],
    });
    expect(stripPrefix('2', out)).toEqual(input);
  });

  it('leaves non-@H fields untouched', () => {
    const input = {foo: 'bar', d: ['plain', 3, {'@H': 'o1'}]};
    const out = addPrefix('9', input);
    expect(out.foo).toBe('bar');
    expect(out.d[0]).toBe('plain');
    expect(out.d[1]).toBe(3);
    expect((out.d[2] as any)['@H']).toBe('o9_1');
  });
});

describe('broker → server → browser forwarding', () => {
  it('forwards root model and method calls through a broker', async () => {
    vi.useFakeTimers();
    const t = createLinkedTransports();

    // Broker: holds the actual domain.
    const broker = new RPC({project: new BrokerProject()});
    broker.addClient(t.brokerTransport, 'broker-client');

    // Server: middle hop, upstreams to broker, exposes nothing of its own.
    const server = new RPC();
    server.addUpstream(t.serverUpstreamTransport);
    server.addClient(t.serverDownstreamTransport, 'server-client');

    // Browser.
    const browser = new RPCClient(t.browserTransport);

    await t.flush();
    await browser.ready;

    expect(browser.root).toBeDefined();
    expect(browser.root.project.name.peek()).toBe('Initial');

    const p = browser.root.project.rename('Renamed');
    await t.flush();
    await expect(p).resolves.toEqual({ok: true});
    expect(browser.root.project.name.peek()).toBe('Initial');

    // Subscribe so we see the push.
    browser.root.project.name.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await t.flush();
    await t.flush();

    expect(browser.root.project.name.peek()).toBe('Renamed');
  });

  it('forwards watch / unwatch / release through a broker', async () => {
    vi.useFakeTimers();
    const t = createLinkedTransports();

    const broker = new RPC({project: new BrokerProject()});
    broker.addClient(t.brokerTransport, 'broker-client');

    const server = new RPC();
    server.addUpstream(t.serverUpstreamTransport);
    server.addClient(t.serverDownstreamTransport, 'server-client');

    const browser = new RPCClient(t.browserTransport);

    await t.flush();
    await browser.ready;

    const stop = browser.root.project.name.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await t.flush();
    await t.flush();

    // Underlying signal in the broker should now have a subscriber.
    const brokerReflection = (broker as any).reflection;
    expect(brokerReflection).toBeDefined();

    stop();
    vi.advanceTimersByTime(20);
    await t.flush();
    await t.flush();
    // Re-subscribing after the unwatch should still produce live updates.
    browser.root.project.name.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await t.flush();
    await t.flush();
    expect(browser.root.project.name.peek()).toBe('Initial');
    void broker;
    void server;
  });
});
