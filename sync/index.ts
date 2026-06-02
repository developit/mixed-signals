/**
 * `mixed-signals/sync` — synchronous RPC for worker-side callers.
 *
 * Block on one or more in-flight RPC promises via `rpc.wait(promises)`
 * in a single `SharedArrayBuffer` + `Atomics.wait` round-trip, returning
 * hydrated results synchronously. Async remains the default; sync is
 * opt-in per-call when the client is configured with a sync-capable
 * transport.
 */

export {
  SyncRPCError,
  SyncRPCNotCrossOriginIsolatedError,
  SyncRPCUnsupportedContextError,
  SyncRPCTimeoutError,
  SyncRPCAlreadyWaitedError,
  SyncRPCNoTransportWaitError,
  SyncRPCReentrancyError,
  SyncRPCIframeBridgeError,
  SyncRPCPayloadTooLargeError,
} from './errors.ts';

export type {SyncablePromise} from './syncable-promise.ts';

export {supportsSync} from './support.ts';
