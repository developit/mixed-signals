/**
 * Node-conditional entry for `mixed-signals/sync`. Reached via the
 * `node` condition in `package.json#exports['./sync']`.
 *
 * Exposes the same public surface as the browser-default
 * `./index.ts`, with one difference: `supportsSync` is resolved from
 * `./support.node.ts` (which statically imports
 * `node:worker_threads.isMainThread`) instead of from `./support.ts`
 * (which probes browser worker-scope globals). The browser bundle
 * never loads this file because the package resolver picks the
 * `default` condition for non-Node consumers.
 *
 * Keep the export list in sync with `./index.ts`. Adding a new
 * public surface name to one file without the other splits the
 * Node and browser surfaces — anything beyond `supportsSync` should
 * be identical.
 */

// ── Capability check (Node-aware) ───────────────────────────────────────
export {supportsSync} from './support.node.ts';

// ── Transport wrappers ──────────────────────────────────────────────────
export {enableSyncServer} from './server.ts';
export {enableSyncClient} from './client.ts';

// ── Iframe topology helpers ─────────────────────────────────────────────
export {createIframeRelayBridge} from './iframe-relay.ts';
export {createIframeBrokerBridge} from './iframe-broker.ts';

// ── Adapter helpers ─────────────────────────────────────────────────────
export {wrapWindowPostMessage, wrapMessagePort} from './adapters.ts';

// ── Error classes (instanceof-checkable family rooted at SyncRPCError) ──
export {
  SyncRPCAlreadyWaitedError,
  SyncRPCError,
  SyncRPCIframeBridgeError,
  SyncRPCNoTransportWaitError,
  SyncRPCNotCrossOriginIsolatedError,
  SyncRPCPayloadTooLargeError,
  SyncRPCReentrancyError,
  SyncRPCTimeoutError,
  SyncRPCUnsupportedContextError,
} from './errors.ts';

// ── Types ───────────────────────────────────────────────────────────────
export type {SyncablePromise} from './syncable-promise.ts';
export type {
  IframeBridge,
  IframeBrokerBridge,
  IframeRelayBridge,
} from './iframe-bridge.ts';
