import type {Signal} from '@preact/signals-core';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Reflected} from '../../client/model.ts';
import {RPCClient} from '../../client/rpc.ts';
import type {Transport} from '../../shared/protocol.ts';

class TestTransport implements Transport {
  sent: string[] = [];
  private onMessageHandler?: (data: {toString(): string}) => void;
  private onOpenHandler?: () => void;
  private onCloseHandler?: () => void;

  send(data: string) {
    this.sent.push(data);
  }
  onMessage(handler: (data: {toString(): string}) => void) {
    this.onMessageHandler = handler;
  }
  onOpen(handler: () => void) {
    this.onOpenHandler = handler;
  }
  onClose(handler: () => void) {
    this.onCloseHandler = handler;
  }
  receive(data: string) {
    this.onMessageHandler?.(data);
  }
  reopen() {
    this.onCloseHandler?.();
    this.onOpenHandler?.();
  }
}

type Detail = {title: Signal<string>; status: Signal<string>};
type Owner = {children: Signal<Detail[]>};
const clients: RPCClient[] = [];

function detailPayload(offset = 0, marker = 'Detail#detail') {
  return {
    '@M': marker,
    title: {'@S': offset + 1, v: `title-${offset}`},
    status: {'@S': offset + 2, v: 'ready'},
  };
}

function ownerPayload(offset = 0) {
  return {
    '@M': 'Owner#owner',
    children: {
      '@S': 'owner:children',
      v: [detailPayload(offset), detailPayload(offset + 50, 'Detail#other')],
    },
  };
}

const sharedRootSignalPayload = {
  '@M': 'Detail#detail',
  title: {'@S': 'version', v: 1},
  status: {'@S': 2, v: 'ready'},
} as unknown as ReturnType<typeof detailPayload>;

function receiveRoot(
  transport: TestTransport,
  processId = 'p1',
  detail?: unknown,
) {
  const root = {
    '@M': 'Root#root',
    version: {'@S': 'version', v: 1},
    ...(detail ? {detail} : {}),
  };
  const info = {connectionId: 'c1', processId, resumed: false};
  transport.receive(`N:@R:${JSON.stringify(root)},${JSON.stringify(info)}`);
}

function receivePlainRoot(transport: TestTransport, processId = 'p1') {
  const root = {version: {'@S': 'version', v: 1}};
  const info = {connectionId: 'c1', processId, resumed: false};
  transport.receive(`N:@R:${JSON.stringify(root)},${JSON.stringify(info)}`);
}

async function setup<T = Detail>(
  payload: unknown = detailPayload(),
  receive = receiveRoot,
) {
  const transport = new TestTransport();
  const client = new RPCClient(transport);
  clients.push(client);
  receive(transport);
  await client.ready;
  const pending = client.call('loadDetail');
  transport.receive(`R1:${JSON.stringify(payload)}`);
  const model: Reflected<T> = await pending;
  transport.sent.length = 0;
  return {client, transport, model};
}

async function reconnect(client: RPCClient, processId = 'p2') {
  const transport = new TestTransport();
  client.reconnect(transport);
  receiveRoot(transport, processId);
  await client.ready;
  return transport;
}

async function becomeIdle(model: Reflected<Detail>, transport: TestTransport) {
  const stop = model.title.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(10);
  stop();
  await vi.advanceTimersByTimeAsync(10);
  expect(transport.sent).toEqual(['N:@W:1', 'N:@U:1']);
  transport.sent.length = 0;
}

async function refresh(transport: TestTransport, id = 2, offset = 10) {
  transport.receive(`R${id}:${JSON.stringify([detailPayload(offset)])}`);
  await vi.advanceTimersByTimeAsync(10);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const client of clients.splice(0)) client.reflection.reset();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('method-returned model reacquisition', () => {
  it.each([
    'p1',
    'p2',
  ])('recovers child-only observers through one shared owner after reconnect to %s', async (processId) => {
    const {client, model: owner} = await setup<Owner>(ownerPayload());
    const children = owner.children.peek();
    for (const child of children) child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);

    const replacement = await reconnect(client, processId);
    expect(replacement.sent).toEqual(['M2:@M:"Detail#detail","Detail#other"']);
    replacement.receive('R2:[null,null]');
    await vi.advanceTimersByTimeAsync(10);
    expect(replacement.sent.at(-1)).toBe('M3:@M:"Owner#owner"');

    replacement.receive(`R3:${JSON.stringify([ownerPayload(10)])}`);
    await vi.advanceTimersByTimeAsync(10);
    expect(replacement.sent.at(-1)).toBe('N:@W:11,61');
    expect(children.map((child) => child.title.peek())).toEqual([
      'title-10',
      'title-60',
    ]);
    replacement.receive('N:@S:11,"live after reconnect"');
    expect(children[0].title.peek()).toBe('live after reconnect');
  });

  it('does not refresh ancestors when the child resolves directly', async () => {
    const {client, model} = await setup<Owner>(ownerPayload());
    const child = model.children.peek()[0];
    child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const replacement = await reconnect(client);
    replacement.receive(`R2:${JSON.stringify([detailPayload(10)])}`);
    await vi.advanceTimersByTimeAsync(10);

    expect(child.title.peek()).toBe('title-10');
    expect(replacement.sent).toEqual(['M2:@M:"Detail#detail"', 'N:@W:11']);
  });

  it.each([
    null,
    {...ownerPayload(), children: {'@S': 'owner:children', v: []}},
  ])('does not revive a child missing from its authorized owner', async (payload) => {
    const {client, model} = await setup<Owner>(ownerPayload());
    const child = model.children.peek()[0];
    child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const replacement = await reconnect(client);
    replacement.receive('R2:[null]');
    await vi.advanceTimersByTimeAsync(10);
    replacement.receive(`R3:${JSON.stringify([payload])}`);
    await vi.advanceTimersByTimeAsync(1000);

    expect(replacement.sent).toEqual([
      'M2:@M:"Detail#detail"',
      'M3:@M:"Owner#owner"',
    ]);
    expect(child.title.peek()).toBe('title-0');
  });

  it('recovers through multiple unobserved ancestors in one fallback batch', async () => {
    const payload = (offset = 0) => ({
      '@M': 'Grandparent#root',
      owner: {'@S': 'grandparent:owner', v: ownerPayload(offset)},
    });
    const {client, model} = await setup<{owner: Signal<Owner>}>(payload());
    const child = model.owner.peek().children.peek()[0];
    child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const replacement = await reconnect(client);
    replacement.receive('R2:[null]');
    await vi.advanceTimersByTimeAsync(10);
    expect(replacement.sent.at(-1)).toBe(
      'M3:@M:"Owner#owner","Grandparent#root"',
    );
    replacement.receive(`R3:${JSON.stringify([null, payload(10)])}`);
    await vi.advanceTimersByTimeAsync(10);
    expect(child.title.peek()).toBe('title-10');
    expect(replacement.sent.at(-1)).toBe('N:@W:11');
  });

  it('falls back to the owner when the direct refresh is rejected', async () => {
    const {client, model} = await setup<Owner>(ownerPayload());
    const child = model.children.peek()[0];
    child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const replacement = await reconnect(client);
    replacement.receive('E2:"unavailable"');
    await vi.advanceTimersByTimeAsync(10);
    expect(replacement.sent.at(-1)).toBe('M3:@M:"Owner#owner"');
    replacement.receive(`R3:${JSON.stringify([ownerPayload(10)])}`);
    await vi.advanceTimersByTimeAsync(10);
    expect(child.title.peek()).toBe('title-10');
    expect(replacement.sent.at(-1)).toBe('N:@W:11');
  });

  it('asks only the most recent owners of a widely shared child', async () => {
    const owners = Array.from({length: 10}, (_, index) => ({
      '@M': `Owner#o${index}`,
      children: {'@S': `o${index}:children`, v: [detailPayload()]},
    }));
    const {client, model} = await setup<Owner[]>(owners);
    const child = model[0].children.peek()[0];
    child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const replacement = await reconnect(client);
    replacement.receive('R2:[null]');
    await vi.advanceTimersByTimeAsync(10);
    const recent = owners.slice(2).map((owner) => `"${owner['@M']}"`);
    expect(replacement.sent.at(-1)).toBe(`M3:@M:${recent.join(',')}`);
  });

  it('records ownership for children held in a nested signal', async () => {
    const {client, transport, model} = await setup<{
      sections: Signal<{open: Signal<Detail[]>}>;
    }>({
      '@M': 'Owner#owner',
      sections: {
        '@S': 'owner:sections',
        v: {open: {'@S': 'owner:open', v: [detailPayload()]}},
      },
    });
    transport.receive(
      `N:@S:"owner:open",${JSON.stringify([detailPayload(50, 'Detail#other')])},"append"`,
    );
    for (const child of model.sections.peek().open.peek())
      child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const replacement = await reconnect(client);
    expect(replacement.sent).toEqual(['M2:@M:"Detail#detail","Detail#other"']);
    replacement.receive('R2:[null,null]');
    await vi.advanceTimersByTimeAsync(10);
    expect(replacement.sent.at(-1)).toBe('M3:@M:"Owner#owner"');
  });

  it('does not walk plain data when recording ownership', async () => {
    const {client, transport} = await setup<Owner>(ownerPayload());
    const rememberChildren = vi.spyOn(
      client.reflection as any,
      'rememberChildren',
    );
    const rows = Array.from({length: 100}, (_, index) => ({index}));
    transport.receive(`N:@S:"owner:children",${JSON.stringify(rows)}`);
    expect(rememberChildren).toHaveBeenCalledTimes(1);
  });

  it('recovers an idle child through its fresh owner on the same connection', async () => {
    const {transport, model} = await setup<Owner>(ownerPayload());
    const child = model.children.peek()[0];
    await becomeIdle(child, transport);

    child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent).toEqual(['M2:@M:"Detail#detail"']);
    transport.receive('R2:[null]');
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent.at(-1)).toBe('M3:@M:"Owner#owner"');
    transport.receive(`R3:${JSON.stringify([ownerPayload(10)])}`);
    await vi.advanceTimersByTimeAsync(10);
    expect(child.title.peek()).toBe('title-10');
    expect(transport.sent.at(-1)).toBe('N:@W:11');
  });

  it('walks only the most recent owners of a widely shared signal', async () => {
    const shared = {'@S': 'shared', v: 0};
    const {client, transport} = await setup(
      Array.from({length: 20}, (_, index) => ({
        '@M': `Owner#o${index}`,
        shared,
      })),
    );
    const rememberChildren = vi.spyOn(
      client.reflection as any,
      'rememberChildren',
    );
    transport.receive('N:@S:"shared",1');
    expect(rememberChildren).toHaveBeenCalledTimes(8);
  });

  it('asks only the nearest owners when a child has many ancestors', async () => {
    const owners = Array.from({length: 8}, (_, index) => ({
      '@M': `Owner#o${index}`,
      children: {'@S': `o${index}:children`, v: [detailPayload()]},
    }));
    const {client, model} = await setup<{owner: Signal<Owner>}[]>(
      owners.map((owner, index) => ({
        '@M': `Grandparent#g${index}`,
        owner: {'@S': `g${index}:owner`, v: owner},
      })),
    );
    const child = model[0].owner.peek().children.peek()[0];
    child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const replacement = await reconnect(client);
    replacement.receive('R2:[null]');
    await vi.advanceTimersByTimeAsync(10);
    expect(replacement.sent.at(-1)).toBe(
      `M3:@M:${owners.map((owner) => `"${owner['@M']}"`).join(',')}`,
    );
  });

  it('does not treat a reference back to the owner as ownership', async () => {
    const part = (index: number) => ({
      ...detailPayload(index * 10, `Detail#${index}`),
      owner: {'@M': 'Owner#owner'},
    });
    const {transport, model} = await setup<{owner: Signal<Owner>}>({
      '@M': 'Grandparent#root',
      owner: {
        '@S': 'grandparent:owner',
        v: {
          '@M': 'Owner#owner',
          children: {'@S': 'owner:children', v: [part(0), part(1)]},
        },
      },
    });
    const child = model.owner.peek().children.peek()[0];
    await becomeIdle(child, transport);

    child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    transport.receive('R2:[null]');
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent.at(-1)).toBe(
      'M3:@M:"Owner#owner","Grandparent#root"',
    );
  });

  it('asks a root-supplied owner for an idle child that arrived after the root', async () => {
    const transport = new TestTransport();
    const client = new RPCClient(transport);
    clients.push(client);
    receiveRoot(transport, 'p1', {
      ...ownerPayload(),
      children: {'@S': 'owner:children', v: []},
    });
    await client.ready;
    transport.receive(
      `N:@S:"owner:children",${JSON.stringify([detailPayload()])},"append"`,
    );
    const child = client.root.detail.children.peek()[0];
    await becomeIdle(child, transport);

    child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    transport.receive('R1:[null]');
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent).toEqual([
      'M1:@M:"Detail#detail"',
      'M2:@M:"Owner#owner"',
    ]);
  });

  it.each([
    'R3:[null]',
    'E3:"unavailable"',
  ])('keeps a fresh owner subscribable after its fallback refresh answers %s', async (reply) => {
    const {transport, model} = await setup<Owner>(ownerPayload());
    const child = model.children.peek()[0];
    await becomeIdle(child, transport);

    child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    transport.receive('R2:[null]');
    await vi.advanceTimersByTimeAsync(10);
    transport.receive(reply);
    await vi.advanceTimersByTimeAsync(10);

    model.children.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent).toEqual([
      'M2:@M:"Detail#detail"',
      'M3:@M:"Owner#owner"',
      'N:@W:"owner:children"',
    ]);
  });

  it('does not replay old wire ids when a model refresh starts before the new root', async () => {
    const {client, model} = await setup(detailPayload(), receivePlainRoot);
    client.root.version.subscribe(() => undefined);
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);

    const second = new TestTransport();
    client.reconnect(second);
    model.status.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(second.sent).toEqual(['M2:@M:"Detail#detail"']);

    receivePlainRoot(second, 'p2');
    await client.ready;
    expect(second.sent).toEqual([
      'M2:@M:"Detail#detail"',
      'M3:@M:"Detail#detail"',
      'N:@W:"version"',
    ]);
  });

  it('records ownership for children delivered by a later signal update', async () => {
    const {client, transport, model} = await setup<Owner>({
      ...ownerPayload(),
      children: {'@S': 'owner:children', v: []},
    });
    transport.receive(
      `N:@S:"owner:children",${JSON.stringify([detailPayload()])},"append"`,
    );
    const child = model.children.peek()[0];
    child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const replacement = await reconnect(client);
    replacement.receive('R2:[null]');
    await vi.advanceTimersByTimeAsync(10);
    expect(replacement.sent.at(-1)).toBe('M3:@M:"Owner#owner"');
    replacement.receive(`R3:${JSON.stringify([ownerPayload(10)])}`);
    await vi.advanceTimersByTimeAsync(10);
    expect(child.title.peek()).toBe('title-10');
    expect(replacement.sent.at(-1)).toBe('N:@W:11');
  });

  it('shares an in-flight ancestor refresh with a newly observed sibling', async () => {
    const {client, model} = await setup<Owner>(ownerPayload());
    const [first, second] = model.children.peek();
    first.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const replacement = await reconnect(client);
    replacement.receive('R2:[null]');
    await vi.advanceTimersByTimeAsync(10);
    second.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    replacement.receive('R4:[null]');
    await vi.advanceTimersByTimeAsync(10);
    expect(replacement.sent).toEqual([
      'M2:@M:"Detail#detail"',
      'M3:@M:"Owner#owner"',
      'M4:@M:"Detail#other"',
    ]);
    replacement.receive(`R3:${JSON.stringify([ownerPayload(10)])}`);
    await vi.advanceTimersByTimeAsync(10);
    expect([first.title.peek(), second.title.peek()]).toEqual([
      'title-10',
      'title-60',
    ]);
    expect(replacement.sent.at(-1)).toBe('N:@W:11,61');
  });

  it('uses the method payload for the first observation', async () => {
    const {transport, model} = await setup();
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);

    expect(transport.sent).toEqual(['N:@W:1']);
    transport.receive('N:@S:1,"live"');
    expect(model.title.peek()).toBe('live');
  });

  it('abandons an ancestor refresh when another transport replaces it', async () => {
    const {client, model} = await setup<Owner>(ownerPayload());
    const child = model.children.peek()[0];
    child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const second = new TestTransport();
    client.reconnect(second);
    receiveRoot(second, 'p2');
    await client.ready;
    second.receive('R2:[null]');
    await vi.advanceTimersByTimeAsync(10);
    expect(second.sent.at(-1)).toBe('M3:@M:"Owner#owner"');

    const third = new TestTransport();
    client.reconnect(third);
    receiveRoot(third, 'p3');
    await client.ready;
    second.receive(`R3:${JSON.stringify([ownerPayload(10)])}`);
    await vi.advanceTimersByTimeAsync(10);
    expect(child.title.peek()).toBe('title-0');
    third.receive('R4:[null]');
    await vi.advanceTimersByTimeAsync(10);
    expect(third.sent.at(-1)).toBe('M5:@M:"Owner#owner"');
    third.receive(`R5:${JSON.stringify([ownerPayload(20)])}`);
    await vi.advanceTimersByTimeAsync(10);
    expect(child.title.peek()).toBe('title-20');
    expect(third.sent.at(-1)).toBe('N:@W:21');
  });

  it('retains recovery markers without requiring the parent facade to stay cached', async () => {
    const {client, model} = await setup<Owner>(ownerPayload());
    const child = model.children.peek()[0];
    child.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const deref = WeakRef.prototype.deref;
    const collected = vi
      .spyOn(WeakRef.prototype, 'deref')
      .mockImplementation(function (this: WeakRef<object>) {
        const value = deref.call(this);
        return value === model ? undefined : value;
      });
    const replacement = new TestTransport();
    try {
      client.reconnect(replacement);
      receiveRoot(replacement, 'p2');
      await client.ready;
      replacement.receive('R2:[null]');
      await vi.advanceTimersByTimeAsync(10);
      expect(replacement.sent.at(-1)).toBe('M3:@M:"Owner#owner"');
    } finally {
      collected.mockRestore();
    }
    replacement.receive(`R3:${JSON.stringify([ownerPayload(10)])}`);
    await vi.advanceTimersByTimeAsync(10);
    expect(child.title.peek()).toBe('title-10');
    expect(replacement.sent.at(-1)).toBe('N:@W:11');
  });

  it('reacquires an idle model once before watching its rebound fields', async () => {
    const {transport, model} = await setup();
    const title = model.title;
    const status = model.status;
    await becomeIdle(model, transport);

    const stopTitle = title.subscribe(() => undefined);
    const stopStatus = status.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.sent).toEqual(['M2:@M:"Detail#detail"']);

    await refresh(transport);
    expect(transport.sent).toEqual(['M2:@M:"Detail#detail"', 'N:@W:11,12']);
    expect(model.title).toBe(title);
    expect(model.status).toBe(status);
    expect(title.peek()).toBe('title-10');
    transport.receive('N:@S:11,"live again"');
    expect(title.peek()).toBe('live again');

    transport.sent.length = 0;
    stopTitle();
    stopStatus();
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent).toEqual(['N:@U:11,12']);
    title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    await refresh(transport, 3, 20);
    expect(transport.sent).toEqual([
      'N:@U:11,12',
      'M3:@M:"Detail#detail"',
      'N:@W:21',
    ]);
    expect(title.peek()).toBe('title-20');
  });

  it('does not reacquire while another field keeps the model observed', async () => {
    const {transport, model} = await setup();
    const stopTitle = model.title.subscribe(() => undefined);
    model.status.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    stopTitle();
    await vi.advanceTimersByTimeAsync(10);
    transport.sent.length = 0;

    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent).toEqual(['N:@W:1']);
  });

  it('preserves the unwatch debounce on a quick remount', async () => {
    const {transport, model} = await setup();
    const stop = model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    transport.sent.length = 0;
    stop();
    await vi.advanceTimersByTimeAsync(5);
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent).toEqual([]);
  });

  it.each([
    'p1',
    'p2',
  ])('lazily reacquires an unobserved model after reconnect to %s', async (processId) => {
    const {client, model} = await setup();
    const transport = new TestTransport();
    client.reconnect(transport);
    receiveRoot(transport, processId);
    await client.ready;
    expect(transport.sent).toEqual([]);

    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.sent).toEqual(['M2:@M:"Detail#detail"']);
    await refresh(transport);
    expect(transport.sent).toEqual(['M2:@M:"Detail#detail"', 'N:@W:11']);
    expect(model.title.peek()).toBe('title-10');
  });

  it('reacquires after the same transport reopens on the same process', async () => {
    const {transport, client, model} = await setup();
    transport.reopen();
    receiveRoot(transport);
    await client.ready;
    expect(transport.sent).toEqual([]);
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.sent).toEqual(['M2:@M:"Detail#detail"']);
    await refresh(transport);
    expect(model.title.peek()).toBe('title-10');
  });

  it('keeps models hydrated by the root out of idle reacquisition', async () => {
    const {client, model} = await setup();
    const transport = new TestTransport();
    client.reconnect(transport);
    receiveRoot(transport, 'p1', detailPayload());
    await client.ready;
    expect(client.root.detail).toBe(model);
    await becomeIdle(model, transport);
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent).toEqual(['N:@W:1']);
  });

  it('reacquires a previously rooted model omitted from a later root', async () => {
    const {client, model} = await setup();
    const rooted = new TestTransport();
    client.reconnect(rooted);
    receiveRoot(rooted, 'p1', detailPayload());
    await client.ready;
    expect(client.root.detail).toBe(model);

    const detached = new TestTransport();
    client.reconnect(detached);
    receiveRoot(detached);
    await client.ready;
    expect(detached.sent).toEqual([]);
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(detached.sent).toEqual(['M2:@M:"Detail#detail"']);
    await refresh(detached);
    expect(model.title.peek()).toBe('title-10');
  });

  it.each([
    'R2:[null]',
    'E2:"unavailable"',
  ])('keeps unresolved models stale after %s and retries on a later observation', async (reply) => {
    const {transport, model} = await setup();
    await becomeIdle(model, transport);
    const stop = model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    transport.receive(reply);
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.sent).toEqual(['M2:@M:"Detail#detail"']);
    expect(model.title.peek()).toBe('title-0');

    stop();
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.sent).toEqual([
      'M2:@M:"Detail#detail"',
      'M3:@M:"Detail#detail"',
    ]);
    await refresh(transport, 3);
    expect(model.title.peek()).toBe('title-10');
    expect(transport.sent.at(-1)).toBe('N:@W:11');
  });

  it('does not watch a refresh abandoned by its last observer', async () => {
    const {transport, model} = await setup();
    await becomeIdle(model, transport);
    model.title.subscribe(() => undefined)();
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.sent).toEqual([]);

    const stop = model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    stop();
    await refresh(transport);
    expect(transport.sent).toEqual(['M2:@M:"Detail#detail"']);

    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.sent.at(-1)).toBe('M3:@M:"Detail#detail"');
    await refresh(transport, 3, 20);
    expect(transport.sent.at(-1)).toBe('N:@W:21');
  });

  it('lets unrelated root signals subscribe while a model refresh is pending', async () => {
    const {transport, client, model} = await setup();
    await becomeIdle(model, transport);
    model.title.subscribe(() => undefined);
    client.root.version.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.sent).toEqual(['M2:@M:"Detail#detail"', 'N:@W:"version"']);
    await refresh(transport);
    expect(model.title.peek()).toBe('title-10');
  });

  it('requests one refresh for models observed in the same flush', async () => {
    const {client, transport, model} = await setup();
    const pending = client.call('loadDetail');
    transport.receive(
      `R2:${JSON.stringify(detailPayload(50, 'Detail#other'))}`,
    );
    const other: Reflected<Detail> = await pending;
    const stops = [model.title, other.title].map((sig) =>
      sig.subscribe(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(10);
    for (const stop of stops) stop();
    await vi.advanceTimersByTimeAsync(10);
    transport.sent.length = 0;

    model.title.subscribe(() => undefined);
    other.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent).toEqual(['M3:@M:"Detail#detail","Detail#other"']);

    transport.receive(
      `R3:${JSON.stringify([detailPayload(10), detailPayload(60, 'Detail#other')])}`,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent.at(-1)).toBe('N:@W:11,61');
  });

  it('preserves a root unwatch queued during reconnect model refresh', async () => {
    const {client, model} = await setup();
    const stopVersion = client.root.version.subscribe(() => undefined);
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);

    const second = new TestTransport();
    client.reconnect(second);
    receiveRoot(second);
    await client.ready;
    expect(second.sent).toEqual(['M2:@M:"Detail#detail"', 'N:@W:"version"']);
    stopVersion();
    await refresh(second);
    expect(second.sent).toEqual([
      'M2:@M:"Detail#detail"',
      'N:@W:"version"',
      'N:@W:11',
      'N:@U:"version"',
    ]);
  });

  it('rewatches a root signal observed again during reconnect model refresh', async () => {
    const {client, model} = await setup();
    const stopVersion = client.root.version.subscribe(() => undefined);
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);

    const second = new TestTransport();
    client.reconnect(second);
    receiveRoot(second);
    await client.ready;
    stopVersion();
    await vi.advanceTimersByTimeAsync(10);
    client.root.version.subscribe(() => undefined);
    await refresh(second);
    expect(second.sent).toEqual([
      'M2:@M:"Detail#detail"',
      'N:@W:"version"',
      'N:@U:"version"',
      'N:@W:"version",11',
    ]);
  });

  it('keeps subscriptions and queued unwatches across a live root rebroadcast', async () => {
    const {client, transport, model} = await setup();
    const stopVersion = client.root.version.subscribe(() => undefined);
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    transport.sent.length = 0;

    stopVersion();
    transport.receive(
      `N:@R:${JSON.stringify({'@M': 'Root#root'})},${JSON.stringify({connectionId: 'c1', processId: 'p1', resumed: false})}`,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.sent).toEqual(['N:@U:"version"']);

    client.root.version.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.sent).toEqual(['N:@U:"version"', 'N:@W:"version"']);
  });

  it('watches a root signal shared with an unresolved held model', async () => {
    const {client, model} = await setup(sharedRootSignalPayload);
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);

    const second = new TestTransport();
    client.reconnect(second);
    receiveRoot(second);
    await client.ready;
    second.receive('R2:[null]');
    await vi.advanceTimersByTimeAsync(100);
    expect(second.sent).toEqual(['M2:@M:"Detail#detail"', 'N:@W:"version"']);
  });

  it.each([
    'p1',
    'p2',
  ])('watches a plain root signal shared with an unresolved held model after reconnect to %s', async (processId) => {
    const {client, model} = await setup(
      sharedRootSignalPayload,
      receivePlainRoot,
    );
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);

    const second = new TestTransport();
    client.reconnect(second);
    receivePlainRoot(second, processId);
    await client.ready;
    second.receive('R2:[null]');
    await vi.advanceTimersByTimeAsync(100);
    expect(second.sent).toEqual(['M2:@M:"Detail#detail"', 'N:@W:"version"']);
  });

  it.each([
    ['model', receiveRoot],
    ['plain', receivePlainRoot],
  ])('watches a %s root signal shared with an idle model without waiting for its refresh', async (_shape, receive) => {
    const {transport, model} = await setup(sharedRootSignalPayload, receive);
    const stop = model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    stop();
    await vi.advanceTimersByTimeAsync(10);
    transport.sent.length = 0;

    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent).toEqual(['M2:@M:"Detail#detail"', 'N:@W:"version"']);
  });

  it('watches active fields when a later payload refreshes an unresolved model', async () => {
    const {client, transport, model} = await setup();
    await becomeIdle(model, transport);
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    transport.receive('R2:[null]');
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.sent).toEqual(['M2:@M:"Detail#detail"']);

    const pending = client.root.loadDetail();
    transport.receive(`R3:${JSON.stringify(detailPayload())}`);
    await pending;
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent.at(-1)).toBe('N:@W:1');
  });

  it('ignores a refresh superseded by another reconnect', async () => {
    const {transport: first, client, model} = await setup();
    await becomeIdle(model, first);
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(first.sent).toEqual(['M2:@M:"Detail#detail"']);

    const second = new TestTransport();
    client.reconnect(second);
    receiveRoot(second);
    await vi.advanceTimersByTimeAsync(100);
    first.receive(`R2:${JSON.stringify([detailPayload(30)])}`);
    expect(second.sent).toEqual(['M3:@M:"Detail#detail"']);
    expect(model.title.peek()).toBe('title-0');
    await refresh(second, 3);
    expect(second.sent).toEqual(['M3:@M:"Detail#detail"', 'N:@W:11']);
    expect(model.title.peek()).toBe('title-10');
  });

  it('keeps a sealed field final while reacquiring another field', async () => {
    const {transport, model} = await setup();
    const stopTitle = model.title.subscribe(() => undefined);
    const stopStatus = model.status.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    transport.receive('N:@S:2,null,"seal"');
    stopTitle();
    stopStatus();
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent).toEqual(['N:@W:1,2', 'N:@U:1']);
    transport.sent.length = 0;

    model.status.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.sent).toEqual([]);
    model.title.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    await refresh(transport);
    expect(transport.sent).toEqual(['M2:@M:"Detail#detail"', 'N:@W:11']);
  });

  it.each([
    'p1',
    'p2',
  ])('does not reacquire a fully sealed model after reconnect to %s', async (processId) => {
    const {client, transport: first, model} = await setup();
    const stopTitle = model.title.subscribe(() => undefined);
    const stopStatus = model.status.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    first.receive('N:@S:1,null,"seal"');
    first.receive('N:@S:2,null,"seal"');
    stopTitle();
    stopStatus();

    const second = new TestTransport();
    client.reconnect(second);
    receiveRoot(second, processId);
    await client.ready;
    model.title.subscribe(() => undefined);
    model.status.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(second.sent).toEqual([]);
    expect(model.title.peek()).toBe('title-0');
  });
});
