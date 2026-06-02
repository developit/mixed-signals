/**
 * Node-conditional entry for `mixed-signals/sync`. Identical to the
 * browser-default `./index.ts` surface, except `supportsSync` is the
 * Node-aware detector that uses `node:worker_threads.isMainThread`
 * instead of the browser worker-scope check.
 *
 * Reached via the `node` condition in `package.json#exports['./sync']`.
 * Browser bundles never load this file because the package
 * resolution router selects `./index.ts` (the `default` condition)
 * for non-Node consumers.
 */

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

export type {SyncablePromise} from './syncable-promise.ts';

export {supportsSync} from './support.node.ts';
