/**
 * Regression tests for the round-1 critical findings against
 * `RPCClient.wait`. These tests assert the documented contracts the
 * original implementation silently violated:
 *
 *   - Partial-claim safety: a validation failure mid-batch must not
 *     leave earlier promises in a permanent `consumed=true` zombie
 *     state. Earlier promises remain claimable after the throw.
 *   - Settle-on-throw: if `transport.wait` throws, every claimed
 *     promise is rejected with the same error before the throw
 *     propagates (no leaked claims).
 *   - `canWait()` is consulted up front so a main-thread caller with
 *     a `wait?`-capable transport sees `SyncRPCUnsupportedContextError`
 *     instead of an engine `TypeError`.
 */
import {describe, expect, it} from 'vitest';
import {RPCClient} from '../../client/rpc.ts';
import {createRawMemoryTransportPair} from '../../server/memory-transport.ts';
import {RPC} from '../../server/rpc.ts';
import type {WireMessage} from '../../shared/protocol.ts';
import {
  SyncRPCAlreadyWaitedError,
  SyncRPCTimeoutError,
  SyncRPCUnsupportedContextError,
} from '../../sync/errors.ts';

describe('RPCClient.wait — partial-claim safety on validation failure', () => {
  it('does not consume earlier promises when a later argument is invalid', async () => {
    const [serverT, clientT] = createRawMemoryTransportPair();
    // Stub `wait?` so we pass the canWait + transport guard but
    // still reach the validation loop.
    const clientTransport = {
      ...clientT,
      wait(): WireMessage[] {
        throw new Error('should not be reached when validation fails');
      },
    };
    const client = new RPCClient(clientTransport);
    const rpc = new RPC({
      identity<T>(v: T) {
        return v;
      },
    });
    rpc.addClient(serverT);
    await client.ready;

    // p1 is a fresh, unconsumed SyncablePromise from the proxy.
    const p1 = client.root.identity('survive');
    // p2 is a plain Promise — invalid input for `wait`.
    const p2 = Promise.resolve('not a SyncablePromise') as never;

    expect(() => client.wait([p1, p2])).toThrow(SyncRPCAlreadyWaitedError);

    // Critical contract: p1 must still be claimable / awaitable.
    // Awaiting it should resolve with 'survive' via the async path,
    // since the auto-fire microtask is the only consumer.
    await expect(p1).resolves.toBe('survive');

    rpc.close();
  });

  it('does not consume earlier promises when a later argument is already consumed', async () => {
    const [serverT, clientT] = createRawMemoryTransportPair();
    const clientTransport = {
      ...clientT,
      wait(): WireMessage[] {
        throw new Error('should not be reached when validation fails');
      },
    };
    const client = new RPCClient(clientTransport);
    const rpc = new RPC({
      identity<T>(v: T) {
        return v;
      },
    });
    rpc.addClient(serverT);
    await client.ready;

    const p1 = client.root.identity('survive');
    // Consume p2 via await before passing it to wait().
    const p2 = client.root.identity('consumed');
    await p2;

    expect(() => client.wait([p1, p2])).toThrow(SyncRPCAlreadyWaitedError);

    // p1 stays awaitable.
    await expect(p1).resolves.toBe('survive');

    rpc.close();
  });
});

describe('RPCClient.wait — transport.wait throw orphans nothing', () => {
  it('rejects every claimed promise when transport.wait throws', async () => {
    const [serverT, clientT] = createRawMemoryTransportPair();
    const thrown = new SyncRPCTimeoutError('stub transport timeout');
    const clientTransport = {
      ...clientT,
      wait(): WireMessage[] {
        throw thrown;
      },
    };
    const client = new RPCClient(clientTransport);
    const rpc = new RPC({
      identity<T>(v: T) {
        return v;
      },
    });
    rpc.addClient(serverT);
    await client.ready;

    const p1 = client.root.identity('a');
    const p2 = client.root.identity('b');
    const p3 = client.root.identity('c');

    expect(() => client.wait([p1, p2, p3])).toThrow(SyncRPCTimeoutError);

    // Every claimed promise rejects with the thrown error — not
    // hangs forever in a zombie consumed state.
    await expect(p1).rejects.toBe(thrown);
    await expect(p2).rejects.toBe(thrown);
    await expect(p3).rejects.toBe(thrown);

    rpc.close();
  });
});

describe('RPCClient.wait — canWait() gate', () => {
  it('throws SyncRPCUnsupportedContextError when context cannot call Atomics.wait', async () => {
    // Simulate a browser main thread by setting globalThis.window
    // to globalThis. The inline canCallAtomicsWaitInThisContext
    // check returns false in that case (browser main + sync wait
    // is forbidden). Stub a `wait?` so the no-transport-wait guard
    // passes; the canWait check must then reject with a typed
    // error rather than letting an engine TypeError leak out of
    // Atomics.wait.
    const [serverT, clientT] = createRawMemoryTransportPair();
    const clientTransport = {
      ...clientT,
      wait(): WireMessage[] {
        return [];
      },
    };
    const client = new RPCClient(clientTransport);
    const rpc = new RPC({
      ping() {
        return 'pong';
      },
    });
    rpc.addClient(serverT);
    await client.ready;

    // Install browser-main-thread sentinel: `window === globalThis`.
    const g = globalThis as unknown as Record<string, unknown>;
    const originalWindow = g.window;
    g.window = g;
    try {
      expect(client.canWait()).toBe(false);
      expect(() => client.wait([client.root.ping()])).toThrow(
        SyncRPCUnsupportedContextError,
      );
    } finally {
      if (originalWindow === undefined) delete g.window;
      else g.window = originalWindow;
    }

    rpc.close();
  });
});
