/**
 * Unit tests for `createIframeRelayBridge`. The helper is browser-
 * targeted (runs on the iframe's main thread), so we drive it from
 * Node via stubbed `Window` and `Worker` surfaces. Full end-to-end
 * browser coverage with real iframes + COI headers lands later via
 * the Playwright harness (deferred to M008 / M001I012T).
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {SyncRPCIframeBridgeError} from '../../sync/errors.ts';
import {_createIframeRelayBridgeInternal} from '../../sync/iframe-relay.ts';

// ── Stubs ────────────────────────────────────────────────────────────────

type MessageHandler = (event: MessageEvent) => void;

interface FakeEventTarget {
  addEventListener(type: 'message', cb: MessageHandler): void;
  removeEventListener(type: 'message', cb: MessageHandler): void;
  /** Inspect attached listeners (for leak assertions). */
  _listeners: MessageHandler[];
  /** Synthetically deliver a message event. */
  _emit(partial: Partial<MessageEvent>): void;
}

type WindowPostMessageFn = (
  data: unknown,
  targetOrigin: string,
  transfer?: readonly unknown[],
) => void;
type WorkerPostMessageFn = (
  data: unknown,
  transfer?: readonly unknown[],
) => void;

function makeFakeWindow(): FakeEventTarget & {
  postMessage: ReturnType<typeof vi.fn<WindowPostMessageFn>>;
} {
  const listeners: MessageHandler[] = [];
  return {
    postMessage: vi.fn<WindowPostMessageFn>(),
    addEventListener(type: 'message', cb: MessageHandler) {
      if (type === 'message') listeners.push(cb);
    },
    removeEventListener(type: 'message', cb: MessageHandler) {
      if (type !== 'message') return;
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    },
    _listeners: listeners,
    _emit(partial: Partial<MessageEvent>) {
      const event = partial as MessageEvent;
      for (const h of listeners.slice()) h(event);
    },
  };
}

function makeFakeWorker(): FakeEventTarget & {
  postMessage: ReturnType<typeof vi.fn<WorkerPostMessageFn>>;
} {
  const listeners: MessageHandler[] = [];
  return {
    postMessage: vi.fn<WorkerPostMessageFn>(),
    addEventListener(type: 'message', cb: MessageHandler) {
      if (type === 'message') listeners.push(cb);
    },
    removeEventListener(type: 'message', cb: MessageHandler) {
      if (type !== 'message') return;
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    },
    _listeners: listeners,
    _emit(partial: Partial<MessageEvent>) {
      const event = partial as MessageEvent;
      for (const h of listeners.slice()) h(event);
    },
  };
}

describe('createIframeRelayBridge — construction', () => {
  it('throws SyncRPCIframeBridgeError when parentOrigin is "null"', () => {
    const localWindow = makeFakeWindow();
    const parentWindow = makeFakeWindow();
    const worker = makeFakeWorker();
    expect(() =>
      _createIframeRelayBridgeInternal({
        worker,
        parentOrigin: 'null',
        _localWindow: localWindow,
        _parentWindow: parentWindow,
      }),
    ).toThrow(SyncRPCIframeBridgeError);
  });

  it('throws when window.parent === window (top-level page)', () => {
    const localWindow = makeFakeWindow();
    const worker = makeFakeWorker();
    expect(() =>
      _createIframeRelayBridgeInternal({
        worker,
        parentOrigin: 'https://example.test',
        _localWindow: localWindow,
        _parentWindow: localWindow,
      }),
    ).toThrow(SyncRPCIframeBridgeError);
  });
});

describe('createIframeRelayBridge — forwarding', () => {
  let parentWindow: ReturnType<typeof makeFakeWindow>;
  let localWindow: ReturnType<typeof makeFakeWindow>;
  let worker: ReturnType<typeof makeFakeWorker>;

  beforeEach(() => {
    parentWindow = makeFakeWindow();
    localWindow = makeFakeWindow();
    worker = makeFakeWorker();
  });

  it('forwards worker → parent verbatim with the configured targetOrigin', () => {
    const bridge = _createIframeRelayBridgeInternal({
      worker,
      parentOrigin: 'https://example.test',
      _localWindow: localWindow,
      _parentWindow: parentWindow,
    });

    const payload = {hello: 'world'};
    worker._emit({data: payload});

    expect(parentWindow.postMessage).toHaveBeenCalledWith(
      payload,
      'https://example.test',
    );
    bridge.dispose();
  });

  it('forwards parent → worker only when source and origin both match', () => {
    const bridge = _createIframeRelayBridgeInternal({
      worker,
      parentOrigin: 'https://example.test',
      _localWindow: localWindow,
      _parentWindow: parentWindow,
    });

    const otherSource = makeFakeWindow();

    // The `source` field on `MessageEvent` is typed as
    // `MessageEventSource` (Window | MessagePort | ServiceWorker).
    // Our fakes are structural Window stand-ins, so we cast through
    // `unknown` to satisfy the destination type without bringing
    // jsdom into the test suite.
    const asSource = (s: unknown) =>
      s as MessageEvent['source'];

    // Source mismatch → dropped.
    localWindow._emit({
      source: asSource(otherSource),
      origin: 'https://example.test',
      data: 'wrong-source',
    });
    // Origin mismatch → dropped.
    localWindow._emit({
      source: asSource(parentWindow),
      origin: 'https://evil.test',
      data: 'wrong-origin',
    });
    // Both match → forwarded.
    localWindow._emit({
      source: asSource(parentWindow),
      origin: 'https://example.test',
      data: 'match',
    });

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith('match');
    bridge.dispose();
  });
});

describe('createIframeRelayBridge — heartbeat', () => {
  let parentWindow: ReturnType<typeof makeFakeWindow>;
  let localWindow: ReturnType<typeof makeFakeWindow>;
  let worker: ReturnType<typeof makeFakeWorker>;

  beforeEach(() => {
    vi.useFakeTimers();
    parentWindow = makeFakeWindow();
    localWindow = makeFakeWindow();
    worker = makeFakeWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not arm the heartbeat before any worker message arrives', () => {
    const bridge = _createIframeRelayBridgeInternal({
      worker,
      parentOrigin: 'https://example.test',
      workerHeartbeatTimeoutMs: 1000,
      _localWindow: localWindow,
      _parentWindow: parentWindow,
    });

    vi.advanceTimersByTime(5000);
    const clientDeadCalls = (
      parentWindow.postMessage.mock.calls as unknown[][]
    ).filter(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as {__sync?: string}).__sync === 'client_dead',
    );
    expect(clientDeadCalls).toHaveLength(0);
    bridge.dispose();
  });

  it('fires client_dead upstream after timeoutMs of worker silence following first message', () => {
    const bridge = _createIframeRelayBridgeInternal({
      worker,
      parentOrigin: 'https://example.test',
      workerHeartbeatTimeoutMs: 1000,
      _localWindow: localWindow,
      _parentWindow: parentWindow,
    });

    // First worker message arms the heartbeat. This message is also
    // forwarded to the parent (mixed with the heartbeat detection).
    worker._emit({data: {first: true}});

    // 999 ms in: no client_dead yet.
    vi.advanceTimersByTime(999);
    let deadCalls = (
      parentWindow.postMessage.mock.calls as unknown[][]
    ).filter(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadCalls).toHaveLength(0);

    // Cross the 1000 ms threshold → client_dead emitted exactly once.
    vi.advanceTimersByTime(2);
    deadCalls = (parentWindow.postMessage.mock.calls as unknown[][]).filter(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadCalls).toHaveLength(1);
    expect(deadCalls[0]?.[1]).toBe('https://example.test');

    // Further silence does not re-fire.
    vi.advanceTimersByTime(5000);
    deadCalls = (parentWindow.postMessage.mock.calls as unknown[][]).filter(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadCalls).toHaveLength(1);

    bridge.dispose();
  });

  it('resets the heartbeat on each subsequent worker message', () => {
    const bridge = _createIframeRelayBridgeInternal({
      worker,
      parentOrigin: 'https://example.test',
      workerHeartbeatTimeoutMs: 1000,
      _localWindow: localWindow,
      _parentWindow: parentWindow,
    });

    worker._emit({data: {first: true}});
    vi.advanceTimersByTime(800);
    worker._emit({data: {ping: true}});
    vi.advanceTimersByTime(800);

    const deadCalls = (
      parentWindow.postMessage.mock.calls as unknown[][]
    ).filter(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadCalls).toHaveLength(0);

    bridge.dispose();
  });
});

describe('createIframeRelayBridge — dispose', () => {
  it('removes both forwarding listeners on dispose', () => {
    const parentWindow = makeFakeWindow();
    const localWindow = makeFakeWindow();
    const worker = makeFakeWorker();

    const bridge = _createIframeRelayBridgeInternal({
      worker,
      parentOrigin: 'https://example.test',
      _localWindow: localWindow,
      _parentWindow: parentWindow,
    });

    expect(localWindow._listeners.length).toBe(1);
    expect(worker._listeners.length).toBe(1);

    bridge.dispose();

    expect(localWindow._listeners.length).toBe(0);
    expect(worker._listeners.length).toBe(0);
  });

  it('dispose() is idempotent', () => {
    const parentWindow = makeFakeWindow();
    const localWindow = makeFakeWindow();
    const worker = makeFakeWorker();

    const bridge = _createIframeRelayBridgeInternal({
      worker,
      parentOrigin: 'https://example.test',
      _localWindow: localWindow,
      _parentWindow: parentWindow,
    });

    expect(() => {
      bridge.dispose();
      bridge.dispose();
      bridge.dispose();
    }).not.toThrow();
  });

  it('post-dispose worker messages are not forwarded', () => {
    const parentWindow = makeFakeWindow();
    const localWindow = makeFakeWindow();
    const worker = makeFakeWorker();

    const bridge = _createIframeRelayBridgeInternal({
      worker,
      parentOrigin: 'https://example.test',
      _localWindow: localWindow,
      _parentWindow: parentWindow,
    });

    worker._emit({data: 'before'});
    expect(parentWindow.postMessage).toHaveBeenCalledTimes(1);

    bridge.dispose();
    worker._emit({data: 'after'});
    expect(parentWindow.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('createIframeRelayBridge — inspection façades', () => {
  it('exposes RawTransport-shaped server and client façades', () => {
    const parentWindow = makeFakeWindow();
    const localWindow = makeFakeWindow();
    const worker = makeFakeWorker();

    const bridge = _createIframeRelayBridgeInternal({
      worker,
      parentOrigin: 'https://example.test',
      _localWindow: localWindow,
      _parentWindow: parentWindow,
    });

    expect(bridge.server.mode).toBe('raw');
    expect(bridge.client.mode).toBe('raw');
    expect(typeof bridge.server.send).toBe('function');
    expect(typeof bridge.client.send).toBe('function');
    expect(typeof bridge.server.onMessage).toBe('function');
    expect(typeof bridge.client.onMessage).toBe('function');

    bridge.dispose();
  });

  it('server façade send routes to parent.postMessage with targetOrigin', () => {
    const parentWindow = makeFakeWindow();
    const localWindow = makeFakeWindow();
    const worker = makeFakeWorker();

    const bridge = _createIframeRelayBridgeInternal({
      worker,
      parentOrigin: 'https://example.test',
      _localWindow: localWindow,
      _parentWindow: parentWindow,
    });

    bridge.server.send({test: true});
    expect(parentWindow.postMessage).toHaveBeenCalledWith(
      {test: true},
      'https://example.test',
      [],
    );

    bridge.dispose();
  });

  it('client façade send routes to worker.postMessage', () => {
    const parentWindow = makeFakeWindow();
    const localWindow = makeFakeWindow();
    const worker = makeFakeWorker();

    const bridge = _createIframeRelayBridgeInternal({
      worker,
      parentOrigin: 'https://example.test',
      _localWindow: localWindow,
      _parentWindow: parentWindow,
    });

    bridge.client.send({test: true});
    expect(worker.postMessage).toHaveBeenCalledWith({test: true}, []);

    bridge.dispose();
  });
});
