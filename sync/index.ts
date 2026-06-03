/**
 * `mixed-signals/sync` — synchronous RPC for worker-side callers.
 *
 * Block on one or more in-flight RPC promises via `rpc.wait(promises)`
 * in a single `SharedArrayBuffer` + `Atomics.wait` round-trip,
 * returning hydrated results synchronously. Async remains the
 * default; sync is opt-in per-call when the client is configured
 * with a sync-capable transport.
 *
 * This file is the **curated public surface**. Internal symbols
 * (SAB header offsets, chunk-state constants, claim/settle hooks,
 * the auto-fire microtask helper, `isSyncablePromise`) stay
 * unexported here so they cannot become de-facto public API; other
 * library modules that need them reach them via direct path imports.
 *
 * The surface mirrors design §8 exactly. New surface additions
 * must update this file AND the matching jsdoc surface.
 */

// ── Capability check ────────────────────────────────────────────────────
export {supportsSync} from './support.ts';

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
