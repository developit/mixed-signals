import type {RawTransport, TransportContext} from '../shared/protocol.ts';
import {SyncRPCIframeBridgeError} from './errors.ts';
import type {IframeRelayBridge} from './iframe-bridge.ts';

/**
 * Minimal `Worker`-shaped surface used by the relay. Extracted as a
 * narrow interface so tests can pass a mock without needing a full
 * DOM `Worker` implementation, and so the runtime contract is
 * explicit in one place.
 *
 * @internal
 */
type WorkerLike = {
  postMessage(data: unknown, transfer?: readonly unknown[]): void;
  addEventListener(type: 'message', cb: (event: MessageEvent) => void): void;
  removeEventListener(
    type: 'message',
    cb: (event: MessageEvent) => void,
  ): void;
};

/**
 * Minimal `Window`-shaped surface used by the relay's parent
 * channel. The runtime is always `window` / `window.parent` from a
 * browser context; the interface is here so tests can stub it.
 *
 * @internal
 */
type WindowLike = {
  postMessage(
    data: unknown,
    targetOrigin: string,
    transfer?: readonly unknown[],
  ): void;
  addEventListener(type: 'message', cb: (event: MessageEvent) => void): void;
  removeEventListener(
    type: 'message',
    cb: (event: MessageEvent) => void,
  ): void;
};

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5000;

/**
 * Same-origin iframe forwarder. Runs on the iframe's main thread and
 * bidirectionally forwards postMessage traffic between
 * `window.parent` (the host context) and the worker the iframe
 * spawned. The relay never blocks — only the leaf worker calls
 * `Atomics.wait` — and never inspects payloads.
 *
 * **Topology requirements.**
 *
 *   - The parent page, this iframe, and the worker must all share an
 *     origin and be cross-origin isolated (COOP `same-origin` + COEP
 *     `require-corp`).
 *   - `parentOrigin` must match `window.parent`'s origin exactly.
 *     Messages from any other origin are rejected.
 *   - Opaque-origin parents (`parentOrigin === 'null'`) are rejected
 *     at construction. Sandboxed iframes without `allow-same-origin`
 *     produce that condition; use `createIframeBrokerBridge`
 *     instead.
 *
 * **What flows.**
 *
 *   - The SAB pair is transferred parent → iframe → worker during
 *     `enableSyncClient`'s handshake. postMessage between same-origin
 *     COI contexts preserves `SharedArrayBuffer` *references* (not
 *     structured-cloned copies), so the same backing memory is
 *     reachable from all three contexts after delivery.
 *   - Subsequent traffic — doorbells, pulls, and normal RPC frames
 *     — flows through the same forwarding path. The relay does not
 *     parse payloads.
 *
 * **What the bridge exposes.**
 *
 *   - `dispose()` removes both forwarding listeners + the heartbeat
 *     timer. Safe to call any number of times; subsequent calls are
 *     no-ops.
 *   - `server` and `client` are `RawTransport` façades around the
 *     parent and worker postMessage primitives, **for inspection
 *     only**. Calling `.send(...)` on them bypasses the bridge's
 *     verification and may corrupt in-flight sync calls; the
 *     intended use is to attach passive `onMessage` listeners for
 *     debug / observability hooks.
 *   - Worker heartbeat: after the first worker message arrives, a
 *     timer is armed for `workerHeartbeatTimeoutMs` (default 5000
 *     ms). If no further worker message lands within that window,
 *     the relay posts `{__sync: 'client_dead'}` upstream to the
 *     parent exactly once. The full worker-teardown lifecycle
 *     protocol lands in a later milestone; this hook is the
 *     detection point.
 *
 * **Constructing two relays against the same worker is forbidden.**
 * Worker postMessage events fan out to every attached listener, so
 * two relays would forward each message twice. Document loudly; not
 * enforced at runtime.
 *
 * @throws SyncRPCIframeBridgeError — `parentOrigin === 'null'`, or
 *   the runtime lacks a usable `window` / `window.parent` (e.g. the
 *   helper was invoked from a top-level page or a non-browser
 *   context).
 */
export function createIframeRelayBridge(opts: {
  /** The extension worker the iframe spawned. */
  worker: WorkerLike;
  /** `targetOrigin` for `window.parent.postMessage(...)`. */
  parentOrigin: string;
  /** Heartbeat timeout for detecting blocked-worker death. */
  workerHeartbeatTimeoutMs?: number;
  /**
   * Local window the relay attaches its parent-side listener to.
   * Defaults to the runtime `globalThis` cast as `Window`. Exposed
   * so unit tests can inject a stub without a full DOM.
   *
   * @internal
   */
  _localWindow?: WindowLike;
  /**
   * Parent window to forward messages to. Defaults to
   * `globalThis.parent` (the iframe's parent in browsers). Exposed
   * so unit tests can inject a stub.
   *
   * @internal
   */
  _parentWindow?: WindowLike;
}): IframeRelayBridge {
  const {
    worker,
    parentOrigin,
    workerHeartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
    _localWindow,
    _parentWindow,
  } = opts;

  if (parentOrigin === 'null') {
    throw new SyncRPCIframeBridgeError(
      'createIframeRelayBridge: parentOrigin is "null" (opaque). ' +
        'Sandboxed iframes without allow-same-origin cannot be a relay; ' +
        'use createIframeBrokerBridge for cross-origin / opaque-origin chains.',
    );
  }

  // Resolve runtime window handles. `globalThis` is the canonical
  // platform-neutral handle; in iframe code it's `window`.
  const localWindow =
    _localWindow ??
    (globalThis as unknown as {addEventListener?: unknown})
      .addEventListener !== undefined
      ? (_localWindow ?? (globalThis as unknown as WindowLike))
      : (undefined as unknown as WindowLike);
  const parentWindow =
    _parentWindow ??
    ((globalThis as unknown as {parent?: WindowLike}).parent as
      | WindowLike
      | undefined);

  if (!localWindow || typeof localWindow.addEventListener !== 'function') {
    throw new SyncRPCIframeBridgeError(
      'createIframeRelayBridge: no usable window.addEventListener; ' +
        'this helper must run inside a browser iframe.',
    );
  }
  if (!parentWindow || typeof parentWindow.postMessage !== 'function') {
    throw new SyncRPCIframeBridgeError(
      'createIframeRelayBridge: no usable window.parent.postMessage; ' +
        'this helper must run inside a browser iframe.',
    );
  }
  if (parentWindow === localWindow) {
    throw new SyncRPCIframeBridgeError(
      'createIframeRelayBridge: window.parent === window. The relay ' +
        'must run inside an iframe, not in the top-level window.',
    );
  }

  let disposed = false;

  // Heartbeat state. Armed lazily on the first worker message, so an
  // idle pre-handshake worker isn't declared dead prematurely.
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let deadEmitted = false;
  const armHeartbeat = () => {
    if (disposed || deadEmitted) return;
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      if (disposed || deadEmitted) return;
      deadEmitted = true;
      parentWindow.postMessage({__sync: 'client_dead'}, parentOrigin);
    }, workerHeartbeatTimeoutMs);
  };

  // Worker → parent forwarder. Forwards `event.data` verbatim so
  // SABs and transferables pass through untouched.
  const fromWorker = (event: MessageEvent) => {
    if (disposed) return;
    armHeartbeat();
    parentWindow.postMessage(event.data, parentOrigin);
  };
  worker.addEventListener('message', fromWorker);

  // Parent → worker forwarder. Origin-pinned + source-pinned so
  // unrelated `message` events on the iframe (other frames, browser
  // extensions, etc.) don't bleed into the sync channel.
  const fromParent = (event: MessageEvent) => {
    if (disposed) return;
    if (event.source !== parentWindow) return;
    if (event.origin !== parentOrigin) return;
    worker.postMessage(event.data);
  };
  localWindow.addEventListener('message', fromParent);

  // ── Inspection-only façades ───────────────────────────────────────────
  //
  // Each façade re-uses the underlying postMessage / addEventListener
  // surfaces of the corresponding side. They share state with the
  // bridge: `dispose()`-ing the bridge also detaches every façade's
  // listeners by clearing the bridge's own.

  const serverFacade: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      if (disposed) return;
      const transfer =
        (ctx as TransportContext | undefined)?.transfer ?? [];
      parentWindow.postMessage(data, parentOrigin, transfer);
    },
    onMessage(cb) {
      const wrapper = (event: MessageEvent) => {
        if (disposed) return;
        if (event.source !== parentWindow) return;
        if (event.origin !== parentOrigin) return;
        cb(event.data);
      };
      localWindow.addEventListener('message', wrapper);
    },
  };

  const clientFacade: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      if (disposed) return;
      const transfer =
        (ctx as TransportContext | undefined)?.transfer ?? [];
      worker.postMessage(data, transfer);
    },
    onMessage(cb) {
      const wrapper = (event: MessageEvent) => {
        if (disposed) return;
        cb(event.data);
      };
      worker.addEventListener('message', wrapper);
    },
  };

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      worker.removeEventListener('message', fromWorker);
      localWindow.removeEventListener('message', fromParent);
      if (heartbeatTimer !== null) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
    },
    server: serverFacade,
    client: clientFacade,
  };
}
