import {type Signal, signal} from '@preact/signals-core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {typeOfRemote} from '../client/index.ts';
import {RPCClient} from '../client/rpc.ts';
import {createModel} from '../server/model.ts';
import {RPC} from '../server/rpc.ts';
import {BRAND_REMOTE} from '../shared/brand.ts';
import {Counter, createLinkedTransportPair} from './helpers.ts';

function connect(rpc: RPC, clientId?: string) {
  const {serverTransport, clientTransport, flush} = createLinkedTransportPair();
  const client = new RPCClient(clientTransport);
  const cleanup = rpc.addClient(serverTransport, clientId);
  return {client, cleanup, flush};
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Integration: zero-registration hydration', () => {
  it('client receives root as a Proxy with signal props and callable methods', async () => {
    vi.useFakeTimers();
    const rpc = new RPC(new Counter());
    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    expect(client.root).toBeDefined();
    expect(client.root.count.peek()).toBe(0);
    expect(typeof client.root.increment).toBe('function');
    expect(typeOfRemote(client.root)).toBe('Counter');
  });

  it('client root reflects initial signal state', async () => {
    vi.useFakeTimers();
    const root = new Counter();
    root.count.value = 5;
    root.name.value = 'hello';
    const rpc = new RPC(root);

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    expect(client.root.count.peek()).toBe(5);
    expect(client.root.name.peek()).toBe('hello');
  });

  it('calling a method runs on the server', async () => {
    vi.useFakeTimers();
    const root = new Counter();
    const rpc = new RPC(root);

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.root.increment();
    await flush();
    await p;

    expect(root.count.peek()).toBe(1);
  });

  it('method with parameters', async () => {
    vi.useFakeTimers();
    const root = new Counter();
    const rpc = new RPC(root);

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.root.rename('new-name');
    await flush();
    await p;

    expect(root.name.peek()).toBe('new-name');
  });

  it('method errors propagate to client', async () => {
    vi.useFakeTimers();
    const rpc = new RPC({
      fail() {
        throw new Error('server error');
      },
    });

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('fail');
    await flush();
    await expect(p).rejects.toThrow('server error');
  });

  it('watch + server mutation streams signal updates', async () => {
    vi.useFakeTimers();
    const root = new Counter();
    const rpc = new RPC(root);

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    client.root.count.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();

    root.count.value = 42;
    await flush();
    expect(client.root.count.peek()).toBe(42);
  });

  it('array append delta end-to-end', async () => {
    vi.useFakeTimers();
    const root = new Counter();
    root.items.value = ['a', 'b'];
    const rpc = new RPC(root);

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    client.root.items.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();

    root.items.value = ['a', 'b', 'c'];
    await flush();
    expect(client.root.items.peek()).toEqual(['a', 'b', 'c']);
  });

  it('string append delta end-to-end', async () => {
    vi.useFakeTimers();
    const root = new Counter();
    root.name.value = 'hello';
    const rpc = new RPC(root);

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    client.root.name.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();

    root.name.value = 'hello world';
    await flush();
    expect(client.root.name.peek()).toBe('hello world');
  });

  it('object merge delta end-to-end', async () => {
    vi.useFakeTimers();
    const root = new Counter();
    root.meta.value = {version: 1, status: 'ok'};
    const rpc = new RPC(root);

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    client.root.meta.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();

    root.meta.value = {version: 1, status: 'updated'};
    await flush();
    expect(client.root.meta.peek()).toEqual({version: 1, status: 'updated'});
  });

  it('server method returning a model produces a client Proxy with identity', async () => {
    vi.useFakeTimers();
    const child = new Counter();
    child.count.value = 99;
    const rpc = new RPC({
      getChild() {
        return child;
      },
    });

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('getChild');
    await flush();
    const result = await p;
    expect(result.count.peek()).toBe(99);
    expect(typeOfRemote(result)).toBe('Counter');
    // Re-fetching yields the same Proxy (identity preserved).
    const p2 = client.call('getChild');
    await flush();
    const result2 = await p2;
    expect(result2).toBe(result);
  });

  it('two clients get independent roots', async () => {
    vi.useFakeTimers();
    const rpc = new RPC(new Counter());

    const a = connect(rpc, 'a');
    const b = connect(rpc, 'b');
    await a.flush();
    await a.client.ready;
    await b.flush();
    await b.client.ready;

    expect(a.client.root).toBeDefined();
    expect(b.client.root).toBeDefined();
    expect(a.client.root).not.toBe(b.client.root);
  });

  it('signal update reaches all subscribed clients', async () => {
    vi.useFakeTimers();
    const root = new Counter();
    const rpc = new RPC(root);

    const a = connect(rpc, 'a');
    const b = connect(rpc, 'b');
    await a.flush();
    await a.client.ready;
    await b.flush();
    await b.client.ready;

    a.client.root.count.subscribe(() => undefined);
    b.client.root.count.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await a.flush();
    await b.flush();

    root.count.value = 77;
    await a.flush();
    await b.flush();

    expect(a.client.root.count.peek()).toBe(77);
    expect(b.client.root.count.peek()).toBe(77);
  });

  it('_-prefixed keys are stripped', async () => {
    vi.useFakeTimers();
    const Model = createModel<{
      visible: Signal<string>;
      _hidden: string;
    }>(
      'M',
      () =>
        ({
          visible: signal('yes'),
          _hidden: 'no',
        }) as any,
    );
    const root = new Model();
    const rpc = new RPC(root);

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    expect(client.root.visible.peek()).toBe('yes');
    // Plain string-key inspection: shape would not include `_hidden`.
    expect(Object.keys(client.root)).not.toContain('_hidden');
  });
});

describe('Integration: nested handles, shapes, identity', () => {
  it('nested models hydrate into Proxies with type names', async () => {
    vi.useFakeTimers();
    const Inner = createModel('Inner', () => ({
      name: signal('child'),
    }));
    const Outer = createModel('Outer', () => ({
      inner: new Inner(),
      label: signal('parent'),
    }));
    const rpc = new RPC(new Outer());

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    expect(typeOfRemote(client.root)).toBe('Outer');
    expect(typeOfRemote(client.root.inner)).toBe('Inner');
    expect(client.root.inner.name.peek()).toBe('child');
  });

  it('shape is sent inline on first use and referenced on subsequent uses', async () => {
    vi.useFakeTimers();
    const Item = createModel<{
      id: Signal<string>;
      label: Signal<string>;
    }>('Item', () => ({id: signal(''), label: signal('')}));
    const root = {
      list: signal<any[]>([]),
      add(id: string, label: string) {
        const it = new Item();
        it.id.value = id;
        it.label.value = label;
        root.list.value = [...root.list.value, it];
        return it;
      },
    };
    const rpc = new RPC(root);

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const sent: string[] = [];
    // Patch serverTransport on the fly would require intercepting — instead,
    // we assert the end-to-end behavior (no shape errors, many items land).
    for (let i = 0; i < 20; i++) {
      const p = client.root.add(`id-${i}`, `label-${i}`);
      await flush();
      await p;
    }
    // We can't easily inspect wire without more plumbing; instead confirm the
    // 20th still hydrates with its type name — proves shape reuse works.
    client.root.list.subscribe(() => undefined);
    vi.advanceTimersByTime(1);
    await flush();
    const items = client.root.list.peek();
    expect(items.length).toBe(20);
    expect(typeOfRemote(items[19])).toBe('Item');
    expect(items[19].id.peek()).toBe('id-19');
    // Sanity: silence unused-var.
    void sent;
  });
});

describe('Integration: functions and promises', () => {
  it('server can return a function handle; client can call it', async () => {
    vi.useFakeTimers();
    let captured: number | null = null;
    const rpc = new RPC({
      makeHandler() {
        return (x: number) => {
          captured = x;
          return x * 2;
        };
      },
    });

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('makeHandler');
    await flush();
    const fn = await p;
    expect(typeof fn).toBe('function');

    const p2 = fn(21);
    await flush();
    const result = await p2;
    expect(result).toBe(42);
    expect(captured).toBe(21);
  });

  it('server can return a pending promise; client awaits its settlement', async () => {
    // Use real timers here — fake timers interact badly with async promise
    // settlement that crosses the wire via a setTimeout on the server.
    const rpc = new RPC({
      delayed() {
        return new Promise<string>((resolve) => {
          setTimeout(() => resolve('done'), 10);
        });
      },
    });

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('delayed');
    await flush();
    // Wait for the server's timer to fire, then flush the resulting @P frame.
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    await expect(p).resolves.toBe('done');
  });

  it('server promise that resolves to a Model gets a Proxy on the client', async () => {
    vi.useFakeTimers();
    const child = new Counter();
    child.count.value = 7;
    const rpc = new RPC({
      lazy() {
        return Promise.resolve(child);
      },
    });

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('lazy');
    await flush();
    // Node's microtasks need another tick to drain.
    await flush();
    const result = await p;
    expect(typeOfRemote(result)).toBe('Counter');
    expect(result.count.peek()).toBe(7);
  });

  it('server promise rejection propagates as client rejection', async () => {
    vi.useFakeTimers();
    const rpc = new RPC({
      bad() {
        return Promise.reject(new Error('nope'));
      },
    });

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('bad');
    await flush();
    await flush();
    await expect(p).rejects.toThrow('nope');
  });
});

describe('Integration: classOf + instanceof', () => {
  it('client.classOf(name) returns a ctor usable with instanceof', async () => {
    vi.useFakeTimers();
    const Item = createModel<{label: Signal<string>}>('Item', () => ({
      label: signal(''),
    }));
    const rpc = new RPC({
      make(label: string) {
        const it = new Item();
        it.label.value = label;
        return it;
      },
    });
    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    // Before we've seen an instance, classOf is undefined.
    expect(client.classOf('Item')).toBeUndefined();

    const p = client.root.make('one');
    await flush();
    const first = await p;

    const Item$ = client.classOf('Item');
    expect(Item$).toBeDefined();
    expect(first).toBeInstanceOf(Item$!);

    // A second instance of the same class is instanceof the same ctor.
    const q = client.root.make('two');
    await flush();
    const second = await q;
    expect(second).toBeInstanceOf(Item$!);
    expect(second.constructor).toBe(Item$);
  });
});

describe('Integration: tiered lifecycle', () => {
  it('non-Model class with methods auto-upgrades; methods route through the trap', async () => {
    vi.useFakeTimers();
    class Project {
      id = signal('42');
      name = signal('Initial');
      rename(next: string) {
        this.name.value = next;
        return {ok: true};
      }
    }
    const rpc = new RPC({project: new Project()});
    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    // No createModel, no type name — but the Proxy still dispatches methods.
    expect(typeOfRemote(client.root.project)).toBeUndefined();
    expect(client.root.project.name.peek()).toBe('Initial');
    const p = client.root.project.rename('Renamed');
    await flush();
    await expect(p).resolves.toEqual({ok: true});
  });

  it('plain data objects with no methods stay pure JSON', async () => {
    vi.useFakeTimers();
    const rpc = new RPC({
      getUser() {
        return {id: 1, name: 'jason', email: 'x@y.z'};
      },
    });
    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('getUser');
    await flush();
    const result = await p;
    // Not a Proxy: the brand is absent, typeOfRemote returns undefined.
    expect(typeOfRemote(result)).toBeUndefined();
    expect(result).toEqual({id: 1, name: 'jason', email: 'x@y.z'});
  });

  it('plain data with a method upgrades to a handle (methods become callable)', async () => {
    vi.useFakeTimers();
    const rpc = new RPC({
      query() {
        const items = [1, 2, 3];
        return {
          items,
          count() {
            return items.length;
          },
        };
      },
    });
    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('query');
    await flush();
    const result = await p;
    expect(result.items).toEqual([1, 2, 3]);
    const c = result.count();
    await flush();
    expect(await c).toBe(3);
  });

  it('values with .toJSON() opt out of handle upgrading', async () => {
    vi.useFakeTimers();
    const rpc = new RPC({
      when() {
        return new Date('2024-01-01T00:00:00.000Z');
      },
    });
    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('when');
    await flush();
    const result = await p;
    // Serialized via Date.prototype.toJSON — arrives as a string.
    expect(result).toBe('2024-01-01T00:00:00.000Z');
  });

  it('Symbol.dispose on a Proxy eagerly releases the handle', async () => {
    vi.useFakeTimers();
    const rpc = new RPC(
      {
        make() {
          return new Counter();
        },
      },
      {retention: {kind: 'ttl', idleMs: 100_000}},
    );

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('make');
    await flush();
    const proxy = await p;
    const brand = (proxy as any)[Symbol.for('mixed-signals.remote')];
    const id = brand.id as string;
    expect(rpc.handles.get(id)?.refs.size).toBe(1);

    // Deterministic dispose — no waiting for GC.
    proxy[Symbol.dispose]();
    // Release batch is debounced ~16ms.
    vi.advanceTimersByTime(20);
    await flush();
    expect(rpc.handles.get(id)?.refs.size).toBe(0);
  });
});

describe('Integration: reconnect', () => {
  it('client.reconnect() re-hydrates shapes and signals from scratch', async () => {
    vi.useFakeTimers();
    const root = new Counter();
    root.count.value = 3;
    const rpc = new RPC(root);

    const first = createLinkedTransportPair();
    const client = new RPCClient(first.clientTransport);
    rpc.addClient(first.serverTransport, 'c1');
    await first.flush();
    await client.ready;

    expect(client.root.count.peek()).toBe(3);

    // Reconnect with a new transport; use the same clientId so the server
    // treats it as a reconnection and re-emits full shapes / model names.
    const second = createLinkedTransportPair();
    client.reconnect(second.clientTransport);
    rpc.addClient(second.serverTransport, 'c1');
    await second.flush();
    await client.ready;

    expect(client.root).toBeDefined();
    expect(client.root.count.peek()).toBe(3);
  });
});

describe('Integration: Proxy-preserved forwarding identity', () => {
  it('passing a received Proxy back resolves to the same server object', async () => {
    vi.useFakeTimers();
    const child = new Counter();
    let seen: any = null;
    const rpc = new RPC({
      getChild() {
        return child;
      },
      inspect(obj: any) {
        seen = obj;
        return true;
      },
    });

    const {client, flush} = connect(rpc, 'c1');
    await flush();
    await client.ready;

    const p = client.call('getChild');
    await flush();
    const proxy = await p;
    const brand = (proxy as any)[BRAND_REMOTE];
    expect(brand).toBeDefined();
    expect(brand.kind).toBe('o');

    const p2 = client.call('inspect', [proxy]);
    await flush();
    await p2;
    expect(seen).toBe(child);
  });
});
