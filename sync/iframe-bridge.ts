import type {RawTransport} from '../shared/protocol.ts';

/**
 * Base interface for all iframe-bridge entities. A bridge owns the
 * cross-realm wiring between a host-side transport and a worker.
 * Consumers hold the returned bridge so they can call `dispose()` on
 * teardown, and may inspect the two transport sides for debugging.
 *
 * Both `server` and `client` are intended for **inspection only**.
 * They expose the underlying transports the bridge owns so debug hooks
 * can attach a passive `onMessage` listener or read `mode` / `ready`
 * state. Calling `.send(...)` on either bypasses the bridge's
 * protocol state and may corrupt in-flight sync calls.
 */
export interface IframeBridge {
  /**
   * Tear down the bridge: stop forwarding listeners, release SAB
   * references the bridge holds, and dispose of the worker channel.
   * Idempotent — calling `dispose()` more than once is a no-op.
   */
  dispose(): void;

  /**
   * Transport facing the host (parent window). **Inspection only.**
   * Sending on this transport directly bypasses the bridge's
   * protocol state and may corrupt in-flight sync calls.
   */
  readonly server: RawTransport;

  /**
   * Transport facing the client (worker). **Inspection only.**
   * Sending on this transport directly bypasses the bridge's
   * protocol state and may corrupt in-flight sync calls.
   */
  readonly client: RawTransport;
}

/**
 * Same-origin iframe forwarder. Returned by `createIframeRelayBridge`.
 *
 * Use this topology when the iframe and its parent window share an
 * origin (e.g. internal devtools, examples, tests). The iframe is a
 * dumb pipe — it never blocks, never inspects payloads, and the SABs
 * travel parent → iframe → worker via postMessage at handshake time.
 *
 * **Do not use across origins.** Cross-origin SAB postMessage is
 * rejected at the agent-cluster boundary; use
 * `createIframeBrokerBridge` for the cross-origin case.
 *
 * Extends `IframeBridge` unchanged today; exists as a distinct type
 * so consumers can constrain return shapes precisely (a function
 * declared to return an `IframeRelayBridge` is explicitly the
 * same-origin variant).
 */
export interface IframeRelayBridge extends IframeBridge {}

/**
 * Cross-origin iframe active broker. Returned by
 * `createIframeBrokerBridge`.
 *
 * Use this topology when the iframe and its parent window are in
 * different origins (the typical Shopify-extension shape: host page +
 * CDN-served iframe + extension worker). The iframe is not a relay
 * but an **active broker** that owns the SAB pair inside its same-
 * origin pair with the worker; the iframe ↔ parent hop is async
 * postMessage / `MessagePort`. The SAB never crosses the
 * cross-origin boundary.
 *
 * Extends `IframeBridge` unchanged today; exists as a distinct type
 * so consumers can constrain return shapes precisely (a function
 * declared to return an `IframeBrokerBridge` is explicitly the
 * cross-origin variant).
 */
export interface IframeBrokerBridge extends IframeBridge {}
