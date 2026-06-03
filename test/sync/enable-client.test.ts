/**
 * Unit tests for `enableSyncClient`. These cover the worker-side
 * wrapper's contract surface independent of the host wrapper:
 *
 *   - Handshake timing + timeout + malformed payload.
 *   - Handshake-window message queue (preserves arrival order).
 *   - Input validation on `timeoutMs`.
 *
 * The full SAB protocol round trip (request + response chunking,
 * `Atomics.wait` blocking) is exercised end-to-end against
 * `enableSyncServer` in `enable-server.test.ts` already, where the
 * caller side is an inline raw-Atomics fixture. The corresponding
 * integration coverage with `enableSyncClient` as the caller side
 * lives in `enable-client-server.test.ts`.
 */
import {describe, expect, it, vi} from 'vitest';
import type {
  RawTransport,
  TransportContext,
} from '../../shared/protocol.ts';
import {enableSyncClient} from '../../sync/client.ts';
import {
  SyncRPCIframeBridgeError,
  SyncRPCTimeoutError,
} from '../../sync/errors.ts';
import {allocateLane} from '../../sync/lane.ts';

/**
 * Build a paired in-memory raw transport. Both ends share a single
 * queue so we can deliver messages from a test on either side
 * synchronously. The caller (`enableSyncClient`) sees `clientSide`;
 * the test plays the host role through `hostSide`.
 */
function pairedTransports(): {
  clientSide: RawTransport;
  hostSide: RawTransport;
  /** Inbound payloads observed on the host side, in arrival order. */
  hostReceived: unknown[];
} {
  type Handler = (
    data: unknown,
    ctx?: TransportContext,
  ) => void | Promise<void>;
  const clientHandlers: Handler[] = [];
  const hostHandlers: Handler[] = [];
  const hostReceived: unknown[] = [];

  const clientSide: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      hostReceived.push(data);
      for (const h of hostHandlers) h(data, ctx);
    },
    onMessage(cb) {
      clientHandlers.push(cb);
    },
  };

  const hostSide: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      for (const h of clientHandlers) h(data, ctx);
    },
    onMessage(cb) {
      hostHandlers.push(cb);
    },
  };

  return {clientSide, hostSide, hostReceived};
}

describe('enableSyncClient handshake', () => {
  it('resolves with a Transport once the host posts hs-res', async () => {
    const {clientSide, hostSide, hostReceived} = pairedTransports();

    const pending = enableSyncClient(clientSide);

    // The client posts `hs-req` synchronously on invocation.
    expect(hostReceived).toEqual([{__sync: 'hs-req'}]);

    // Stand-in host: allocate SABs and reply.
    const {control, data} = allocateLane();
    hostSide.send({__sync: 'hs-res', control, data});

    const transport = await pending;
    expect(transport.mode).toBe('raw');
    expect(typeof transport.send).toBe('function');
    expect(typeof transport.onMessage).toBe('function');
    expect(typeof transport.wait).toBe('function');
  });

  it('rejects with SyncRPCTimeoutError when no hs-res arrives within timeoutMs', async () => {
    const {clientSide} = pairedTransports();
    // Use a tight timeout for test speed. Setting `unref` keeps the
    // timer from holding the event loop open.
    await expect(
      enableSyncClient(clientSide, {timeoutMs: 30}),
    ).rejects.toBeInstanceOf(SyncRPCTimeoutError);
  });

  it('rejects with SyncRPCIframeBridgeError when hs-res carries malformed SAB fields', async () => {
    const {clientSide, hostSide} = pairedTransports();
    const pending = enableSyncClient(clientSide);

    // Reply with non-SAB values where SABs are expected.
    hostSide.send({
      __sync: 'hs-res',
      control: new ArrayBuffer(256),
      data: new ArrayBuffer(64 * 1024),
    });

    await expect(pending).rejects.toBeInstanceOf(SyncRPCIframeBridgeError);
  });

  it('rejects with RangeError for non-positive timeoutMs', async () => {
    const {clientSide} = pairedTransports();
    await expect(
      enableSyncClient(clientSide, {timeoutMs: 0}),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      enableSyncClient(clientSide, {timeoutMs: -1}),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      enableSyncClient(clientSide, {timeoutMs: 1.5}),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      enableSyncClient(clientSide, {timeoutMs: Number.NaN}),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('enableSyncClient handshake-window message queue', () => {
  it('buffers non-handshake messages until onMessage(cb) registers, then replays in order', async () => {
    const {clientSide, hostSide} = pairedTransports();
    const pending = enableSyncClient(clientSide);

    // The host commonly posts `@R` before the consumer subscribes.
    // Simulate a stream of inbound traffic during the handshake
    // window, interleaved with the hs-res reply.
    hostSide.send({type: 'notification', method: '@R', params: ['root']});
    hostSide.send({type: 'notification', method: '@S', params: ['s1', 1]});

    const {control, data} = allocateLane();
    hostSide.send({__sync: 'hs-res', control, data});

    // More traffic between hs-res and the consumer's subscribe call.
    hostSide.send({type: 'notification', method: '@S', params: ['s2', 2]});

    const transport = await pending;

    // Consumer subscribes — should see the buffered messages in
    // arrival order before any subsequent live traffic.
    const seen: unknown[] = [];
    transport.onMessage((msg) => {
      seen.push(msg);
    });

    expect(seen).toEqual([
      {type: 'notification', method: '@R', params: ['root']},
      {type: 'notification', method: '@S', params: ['s1', 1]},
      {type: 'notification', method: '@S', params: ['s2', 2]},
    ]);

    // Live traffic after subscription routes through immediately.
    hostSide.send({type: 'notification', method: '@S', params: ['s3', 3]});
    expect(seen.at(-1)).toEqual({
      type: 'notification',
      method: '@S',
      params: ['s3', 3],
    });
  });
});

describe('enableSyncClient transport proxying', () => {
  it('outbound send proxies through the base transport', async () => {
    const {clientSide, hostSide, hostReceived} = pairedTransports();
    const pending = enableSyncClient(clientSide);
    const {control, data} = allocateLane();
    hostSide.send({__sync: 'hs-res', control, data});
    const transport = await pending;

    // Sanity check: hs-req is in hostReceived[0]; subsequent traffic
    // appends after.
    hostReceived.length = 0;

    transport.send({type: 'notification', method: 'ping', params: []});
    expect(hostReceived).toEqual([
      {type: 'notification', method: 'ping', params: []},
    ]);
  });
});

describe('enableSyncClient wait input validation', () => {
  it('throws RangeError when wait opts.timeoutMs is non-positive or non-integer', async () => {
    const {clientSide, hostSide} = pairedTransports();
    const pending = enableSyncClient(clientSide);
    const {control, data} = allocateLane();
    hostSide.send({__sync: 'hs-res', control, data});
    const transport = await pending;

    // We can't actually invoke `wait` from the main thread (Atomics.wait
    // is forbidden), but we can drive it just far enough to exercise
    // the synchronous input-validation guard before the Atomics call.
    // Setting `timeoutMs: 0` throws synchronously before any chunk is
    // written.
    const stub = vi
      .spyOn(transport, 'send')
      .mockImplementation(() => {
        /* swallow doorbell so the test doesn't infinite-loop */
      });
    try {
      expect(() => transport.wait!([], {timeoutMs: 0})).toThrow(RangeError);
      expect(() => transport.wait!([], {timeoutMs: 1.5})).toThrow(RangeError);
      expect(() => transport.wait!([], {timeoutMs: Number.NaN})).toThrow(
        RangeError,
      );
    } finally {
      stub.mockRestore();
    }
  });
});
