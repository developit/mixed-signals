import type {RawTransport, TransportContext} from '../shared/protocol.ts';

/**
 * Wrap a target window's `postMessage` as a `RawTransport`.
 *
 * - Inbound messages are filtered by `event.source === source` AND
 *   `event.origin === targetOrigin`. Messages whose `event.origin`
 *   is `'null'` (sandboxed iframes, opaque origins) are rejected
 *   unconditionally — opaque-origin participants in a sync chain are
 *   a misconfiguration.
 * - Outbound `send(data, ctx)` calls
 *   `source.postMessage(data, targetOrigin, transferList)`, where
 *   `transferList` comes from `ctx?.transfer ?? []`. The
 *   targetOrigin pinning ensures the message is rejected by the
 *   browser if `source`'s document navigates to a different origin
 *   before the message is delivered.
 *
 * `dispose()` removes the inbound listener so the returned transport
 * stops receiving messages. Safe to call more than once; subsequent
 * calls are no-ops.
 *
 * Compose this helper to build a `hostTransport` for
 * `createIframeBrokerBridge` when the parent ↔ iframe channel is a
 * direct `window.parent.postMessage` (the "direct" variant of the
 * cross-origin broker — see design §6.5).
 *
 * The inbound listener is attached to `globalThis.addEventListener`,
 * which exists in every browser context (windows, dedicated workers,
 * shared workers, service workers). The helper is browser-only:
 * Node has no global `addEventListener`, so callers running on Node
 * should compose `wrapMessagePort` instead.
 */
export function wrapWindowPostMessage(opts: {
  source: Window;
  targetOrigin: string;
}): RawTransport & {dispose(): void} {
  const {source, targetOrigin} = opts;

  // Subscribers from `onMessage(cb)`. We support more than one because
  // composing transports may layer their own listeners atop the
  // adapter, even though `RPC.addClient` registers exactly one.
  type Listener = (data: unknown, ctx?: TransportContext) => void | Promise<void>;
  const listeners: Listener[] = [];
  let disposed = false;

  // Inbound: filter by source identity AND strict origin. Reject
  // opaque origins unconditionally.
  const onMessage = (event: MessageEvent) => {
    if (disposed) return;
    if (event.source !== source) return;
    if (event.origin === 'null') return;
    if (event.origin !== targetOrigin) return;
    for (const cb of listeners) cb(event.data);
  };

  // `globalThis` is the runtime-agnostic handle for the local
  // execution context's event surface. In browsers and workers it
  // exposes `addEventListener` / `removeEventListener`; we cast to a
  // minimal shape so the file compiles without DOM lib references on
  // every consumer.
  const eventSurface = globalThis as unknown as {
    addEventListener(type: 'message', cb: (event: MessageEvent) => void): void;
    removeEventListener(type: 'message', cb: (event: MessageEvent) => void): void;
  };
  eventSurface.addEventListener('message', onMessage);

  return {
    mode: 'raw',
    send(data, ctx) {
      if (disposed) return;
      // `Window.postMessage` accepts a `transfer` array as either the
      // third positional argument (legacy) or as part of the options
      // object (modern). The legacy positional form is required by
      // older Safari and is universally supported, so we use it.
      const transfer = (ctx as TransportContext | undefined)?.transfer ?? [];
      source.postMessage(data, targetOrigin, transfer);
    },
    onMessage(cb) {
      listeners.push(cb);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      eventSurface.removeEventListener('message', onMessage);
      listeners.length = 0;
    },
  };
}

/**
 * Wrap a `MessagePort` as a `RawTransport`.
 *
 * - Outbound `send(data, ctx)` calls
 *   `port.postMessage(data, transferList)` with `ctx?.transfer`
 *   propagated as the transfer list.
 * - Inbound subscribes via `port.addEventListener('message', ...)`.
 * - `port.start()` is called exactly once, on first `onMessage`
 *   registration. `MessagePort.start()` is idempotent per spec but
 *   the gate avoids a redundant runtime call.
 *
 * `dispose()` removes the listener and closes the port. Safe to
 * call more than once; subsequent calls are no-ops.
 *
 * Compose this helper to build a `hostTransport` for
 * `createIframeBrokerBridge` when the parent ↔ iframe channel is a
 * tunneled `MessagePort` (the "tunneled" variant of the cross-origin
 * broker — see design §6.5), or when integrating with an existing
 * `MessagePort`-based async transport such as Shopify's
 * `screen-sandbox` messenger.
 */
export function wrapMessagePort(opts: {
  port: MessagePort;
}): RawTransport & {dispose(): void} {
  const {port} = opts;

  type Listener = (data: unknown, ctx?: TransportContext) => void | Promise<void>;
  const listeners: Listener[] = [];
  let started = false;
  let disposed = false;

  const onMessage = (event: MessageEvent) => {
    if (disposed) return;
    for (const cb of listeners) cb(event.data);
  };
  port.addEventListener('message', onMessage);

  return {
    mode: 'raw',
    send(data, ctx) {
      if (disposed) return;
      const transfer = (ctx as TransportContext | undefined)?.transfer ?? [];
      port.postMessage(data, transfer);
    },
    onMessage(cb) {
      listeners.push(cb);
      if (!started) {
        started = true;
        port.start();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      port.removeEventListener('message', onMessage);
      listeners.length = 0;
      port.close();
    },
  };
}
