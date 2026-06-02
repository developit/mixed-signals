/**
 * Unit tests for `createIframeBrokerBridge`. Mock-based; full
 * end-to-end cross-origin Playwright coverage lands in M008 / M009.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../../shared/protocol.ts';
import {SyncRPCIframeBridgeError} from '../../sync/errors.ts';
import {createIframeBrokerBridge} from '../../sync/iframe-broker.ts';

type MessageHandler = (event: MessageEvent) => void;

interface FakeWorker {
  postMessage(data: unknown, transfer?: readonly unknown[]): void;
  addEventListener(type: 'message', cb: MessageHandler): void;
  removeEventListener(type: 'message', cb: MessageHandler): void;
  _listeners: MessageHandler[];
  _emit(partial: Partial<MessageEvent>): void;
  _sent: Array<{data: unknown; transfer: readonly unknown[]}>;
}

function makeFakeWorker(): FakeWorker {
  const listeners: MessageHandler[] = [];
  const sent: Array<{data: unknown; transfer: readonly unknown[]}> = [];
  return {
    postMessage(data, transfer = []) {
      sent.push({data, transfer});
    },
    addEventListener(type, cb) {
      if (type === 'message') listeners.push(cb);
    },
    removeEventListener(type, cb) {
      if (type !== 'message') return;
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    },
    _listeners: listeners,
    _emit(partial) {
      const event = partial as MessageEvent;
      for (const h of listeners.slice()) h(event);
    },
    _sent: sent,
  };
}

interface FakeHostTransport extends RawTransport {
  /** Outbound payloads observed on the host transport. */
  sent: Array<{data: unknown; ctx?: TransportContext}>;
  /** Synthetically deliver an inbound message. */
  inbound(data: unknown, ctx?: TransportContext): void;
}

function makeFakeHostTransport(): FakeHostTransport {
  type Cb = (data: unknown, ctx?: TransportContext) => void | Promise<void>;
  const listeners: Cb[] = [];
  const sent: Array<{data: unknown; ctx?: TransportContext}> = [];
  return {
    mode: 'raw',
    send(data, ctx) {
      sent.push({data, ctx});
    },
    onMessage(cb) {
      listeners.push(cb);
    },
    sent,
    inbound(data, ctx) {
      for (const cb of listeners.slice()) cb(data, ctx);
    },
  };
}

describe('createIframeBrokerBridge — construction', () => {
  it('throws SyncRPCIframeBridgeError when crossOriginIsolated is false', () => {
    expect(() =>
      createIframeBrokerBridge({
        worker: makeFakeWorker(),
        hostTransport: makeFakeHostTransport(),
        _crossOriginIsolated: false,
      }),
    ).toThrow(SyncRPCIframeBridgeError);
  });

  it('returns an IframeBrokerBridge with dispose, server, client when COI', () => {
    const host = makeFakeHostTransport();
    const bridge = createIframeBrokerBridge({
      worker: makeFakeWorker(),
      hostTransport: host,
      _crossOriginIsolated: true,
    });

    expect(typeof bridge.dispose).toBe('function');
    expect(bridge.server).toBe(host); // server is the user-supplied transport
    expect(bridge.client.mode).toBe('raw');

    bridge.dispose();
  });
});

describe('createIframeBrokerBridge — handshake (sync)', () => {
  it('processes hs-req from the worker locally and replies via worker.postMessage', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = createIframeBrokerBridge({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
    });

    // Worker initiates handshake.
    worker._emit({data: {__sync: 'hs-req'}});

    // hs-res should have been posted to the worker (NOT to the parent).
    expect(worker._sent.length).toBe(1);
    const handshakeReply = worker._sent[0]?.data as {
      __sync?: string;
      control?: SharedArrayBuffer;
      data?: SharedArrayBuffer;
    };
    expect(handshakeReply.__sync).toBe('hs-res');
    expect(handshakeReply.control).toBeInstanceOf(SharedArrayBuffer);
    expect(handshakeReply.data).toBeInstanceOf(SharedArrayBuffer);

    // The parent never sees the SAB transfer.
    expect(host.sent).toEqual([]);

    bridge.dispose();
  });
});

describe('createIframeBrokerBridge — async pass-through', () => {
  it('forwards normal WireMessages from the worker to the parent', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = createIframeBrokerBridge({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
    });

    const call: WireMessage = {
      type: 'call',
      id: 1,
      method: 'foo',
      params: [],
    };
    worker._emit({data: call});

    expect(host.sent.length).toBe(1);
    expect(host.sent[0]?.data).toEqual(call);

    bridge.dispose();
  });

  it('forwards normal WireMessages from the parent to the worker', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = createIframeBrokerBridge({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
    });

    const result: WireMessage = {
      type: 'result',
      id: 1,
      value: 'pong',
    };
    host.inbound(result);

    expect(worker._sent.length).toBe(1);
    expect(worker._sent[0]?.data).toEqual(result);

    bridge.dispose();
  });
});

describe('createIframeBrokerBridge — heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires client_dead upstream after timeoutMs of worker silence following first message', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = createIframeBrokerBridge({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
      workerHeartbeatTimeoutMs: 1000,
    });

    worker._emit({data: {first: true}});

    vi.advanceTimersByTime(999);
    let deadSends = host.sent.filter(
      (s) =>
        s.data !== null &&
        typeof s.data === 'object' &&
        (s.data as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadSends).toHaveLength(0);

    vi.advanceTimersByTime(2);
    deadSends = host.sent.filter(
      (s) =>
        s.data !== null &&
        typeof s.data === 'object' &&
        (s.data as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadSends).toHaveLength(1);

    bridge.dispose();
  });

  it('does not arm the heartbeat before any worker message arrives', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = createIframeBrokerBridge({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
      workerHeartbeatTimeoutMs: 1000,
    });

    vi.advanceTimersByTime(5000);
    const deadSends = host.sent.filter(
      (s) =>
        s.data !== null &&
        typeof s.data === 'object' &&
        (s.data as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadSends).toHaveLength(0);

    bridge.dispose();
  });
});

describe('createIframeBrokerBridge — dispose', () => {
  it('detaches the worker message listener', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = createIframeBrokerBridge({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
    });

    expect(worker._listeners.length).toBe(1);
    bridge.dispose();
    expect(worker._listeners.length).toBe(0);
  });

  it('dispose() is idempotent', () => {
    const bridge = createIframeBrokerBridge({
      worker: makeFakeWorker(),
      hostTransport: makeFakeHostTransport(),
      _crossOriginIsolated: true,
    });
    expect(() => {
      bridge.dispose();
      bridge.dispose();
      bridge.dispose();
    }).not.toThrow();
  });

  it('post-dispose worker messages are not forwarded', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = createIframeBrokerBridge({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
    });

    worker._emit({data: {type: 'notification', method: '@R', params: []}});
    expect(host.sent.length).toBe(1);

    bridge.dispose();
    worker._emit({data: {type: 'notification', method: '@R', params: []}});
    expect(host.sent.length).toBe(1);
  });
});
