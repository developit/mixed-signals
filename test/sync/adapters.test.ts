import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {wrapMessagePort, wrapWindowPostMessage} from '../../sync/adapters.ts';

/**
 * Await the next message on a MessagePort using Node's
 * EventEmitter-style `.on('message', ...)`, which implicitly calls
 * `port.start()`. Avoids the `addEventListener` + manual `start()`
 * race that bites Web-API-style port use in Node tests.
 */
function nextMessage<T = unknown>(port: MessagePort): Promise<T> {
  return new Promise((resolve) => {
    const handler = (data: unknown) => {
      (port as unknown as {off(e: string, cb: typeof handler): void}).off(
        'message',
        handler,
      );
      resolve(data as T);
    };
    (port as unknown as {on(e: string, cb: typeof handler): void}).on(
      'message',
      handler,
    );
  });
}

describe('wrapMessagePort', () => {
  it('forwards outbound send through port.postMessage', async () => {
    const {port1, port2} = new MessageChannel();
    const transport = wrapMessagePort({port: port1});

    const received = nextMessage(port2);
    transport.send({hello: 'world'});

    expect(await received).toEqual({hello: 'world'});

    transport.dispose();
    port2.close();
  });

  it('delivers inbound messages to onMessage subscribers', async () => {
    const {port1, port2} = new MessageChannel();
    const transport = wrapMessagePort({port: port1});

    const received: unknown[] = [];
    const settle = new Promise<void>((resolve) => {
      transport.onMessage((data) => {
        received.push(data);
        resolve();
      });
    });

    port2.postMessage('hello');
    await settle;
    expect(received).toEqual(['hello']);

    transport.dispose();
    port2.close();
  });

  it('calls port.start() exactly once across multiple onMessage registrations', () => {
    const {port1, port2} = new MessageChannel();
    const startSpy = vi.spyOn(port1, 'start');

    const transport = wrapMessagePort({port: port1});
    transport.onMessage(() => {});
    transport.onMessage(() => {});
    transport.onMessage(() => {});

    expect(startSpy).toHaveBeenCalledTimes(1);

    transport.dispose();
    port2.close();
  });

  it('propagates ctx.transfer through outbound send', () => {
    const {port1, port2} = new MessageChannel();
    const postSpy = vi.spyOn(port1, 'postMessage');

    const transport = wrapMessagePort({port: port1});
    const buf = new ArrayBuffer(8);
    transport.send({buf}, {transfer: [buf]});

    expect(postSpy).toHaveBeenCalledTimes(1);
    const [, transferArg] = postSpy.mock.calls[0]!;
    expect(transferArg).toEqual([buf]);

    transport.dispose();
    port2.close();
  });

  it('dispose() stops further inbound deliveries and closes the port', async () => {
    const {port1, port2} = new MessageChannel();
    const transport = wrapMessagePort({port: port1});

    const received: unknown[] = [];
    transport.onMessage((data) => {
      received.push(data);
    });

    port2.postMessage('before');
    // Tick the event loop so the listener fires.
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toEqual(['before']);

    transport.dispose();
    port2.postMessage('after');
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toEqual(['before']);

    port2.close();
  });

  it('dispose() is idempotent', () => {
    const {port1, port2} = new MessageChannel();
    const transport = wrapMessagePort({port: port1});
    expect(() => {
      transport.dispose();
      transport.dispose();
      transport.dispose();
    }).not.toThrow();
    port2.close();
  });
});

describe('wrapWindowPostMessage', () => {
  // The helper attaches an inbound listener via
  // `globalThis.addEventListener('message', ...)`. Node doesn't
  // expose those globals by default, so we install a minimal
  // EventTarget-like shim on globalThis for each test and tear it
  // down after.
  type MessageHandler = (event: MessageEvent) => void;
  let handlers: MessageHandler[];
  let originalAdd: unknown;
  let originalRemove: unknown;

  beforeEach(() => {
    handlers = [];
    originalAdd = (globalThis as Record<string, unknown>).addEventListener;
    originalRemove = (globalThis as Record<string, unknown>)
      .removeEventListener;
    (globalThis as Record<string, unknown>).addEventListener = (
      type: string,
      cb: MessageHandler,
    ) => {
      if (type === 'message') handlers.push(cb);
    };
    (globalThis as Record<string, unknown>).removeEventListener = (
      type: string,
      cb: MessageHandler,
    ) => {
      if (type !== 'message') return;
      const idx = handlers.indexOf(cb);
      if (idx >= 0) handlers.splice(idx, 1);
    };
  });

  afterEach(() => {
    if (originalAdd === undefined) {
      delete (globalThis as Record<string, unknown>).addEventListener;
    } else {
      (globalThis as Record<string, unknown>).addEventListener = originalAdd;
    }
    if (originalRemove === undefined) {
      delete (globalThis as Record<string, unknown>).removeEventListener;
    } else {
      (globalThis as Record<string, unknown>).removeEventListener =
        originalRemove;
    }
  });

  function emit(partial: Partial<MessageEvent>): void {
    const event = partial as MessageEvent;
    for (const h of handlers.slice()) h(event);
  }

  function makeMockWindow(): Window & {
    sent: Array<{data: unknown; targetOrigin: string; transfer: unknown[]}>;
  } {
    const sent: Array<{
      data: unknown;
      targetOrigin: string;
      transfer: unknown[];
    }> = [];
    const win = {
      postMessage(
        data: unknown,
        targetOrigin: string,
        transfer: unknown[] = [],
      ) {
        sent.push({data, targetOrigin, transfer});
      },
    } as unknown as Window & {sent: typeof sent};
    win.sent = sent;
    return win;
  }

  it('outbound send forwards to source.postMessage with targetOrigin and transfer', () => {
    const win = makeMockWindow();
    const transport = wrapWindowPostMessage({
      source: win,
      targetOrigin: 'https://example.test',
    });

    const buf = new ArrayBuffer(8);
    transport.send({hello: 'world'}, {transfer: [buf]});

    expect(win.sent).toEqual([
      {
        data: {hello: 'world'},
        targetOrigin: 'https://example.test',
        transfer: [buf],
      },
    ]);

    transport.dispose();
  });

  it('inbound onMessage fires only when source and origin both match', () => {
    const win = makeMockWindow();
    const otherWin = makeMockWindow();
    const transport = wrapWindowPostMessage({
      source: win,
      targetOrigin: 'https://example.test',
    });

    const received: unknown[] = [];
    transport.onMessage((data) => {
      received.push(data);
    });

    emit({source: win, origin: 'https://example.test', data: 'match'});
    emit({
      source: otherWin,
      origin: 'https://example.test',
      data: 'wrong-source',
    });
    emit({source: win, origin: 'https://evil.test', data: 'wrong-origin'});

    expect(received).toEqual(['match']);

    transport.dispose();
  });

  it('rejects opaque origin (event.origin === "null") even when source matches', () => {
    const win = makeMockWindow();
    const transport = wrapWindowPostMessage({
      source: win,
      targetOrigin: 'null',
    });

    const received: unknown[] = [];
    transport.onMessage((data) => {
      received.push(data);
    });

    emit({source: win, origin: 'null', data: 'opaque'});
    expect(received).toEqual([]);

    transport.dispose();
  });

  it('dispose() removes the listener and stops further inbound deliveries', () => {
    const win = makeMockWindow();
    const transport = wrapWindowPostMessage({
      source: win,
      targetOrigin: 'https://example.test',
    });

    const received: unknown[] = [];
    transport.onMessage((data) => {
      received.push(data);
    });

    emit({source: win, origin: 'https://example.test', data: 'before'});
    expect(received).toEqual(['before']);

    transport.dispose();

    emit({source: win, origin: 'https://example.test', data: 'after'});
    expect(received).toEqual(['before']);
    expect(handlers).toHaveLength(0);
  });

  it('dispose() is idempotent', () => {
    const win = makeMockWindow();
    const transport = wrapWindowPostMessage({
      source: win,
      targetOrigin: 'https://example.test',
    });
    expect(() => {
      transport.dispose();
      transport.dispose();
    }).not.toThrow();
  });

  it('outbound send is a no-op after dispose', () => {
    const win = makeMockWindow();
    const transport = wrapWindowPostMessage({
      source: win,
      targetOrigin: 'https://example.test',
    });

    transport.dispose();
    transport.send('blocked');
    expect(win.sent).toEqual([]);
  });
});
