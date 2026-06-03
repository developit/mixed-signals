/**
 * Node-side `supportsSync()` detector. Reached via the
 * `mixed-signals/sync` package's `node` subpath conditional export.
 *
 * Uses a static `import` of `node:worker_threads` so module
 * resolution surfaces missing-runtime errors at load time rather
 * than via runtime probing. Browser bundles never import this file
 * because the conditional export routes them to `support.ts`.
 *
 * `SharedArrayBuffer` and `Atomics` are always available in Node
 * 20+ (the project's minimum supported version), so we don't gate
 * on them here.
 */
import {isMainThread} from 'node:worker_threads';

/**
 * Returns `true` iff the current Node context is a `worker_threads`
 * Worker (i.e. not the Node main thread). Worker threads are the
 * only Node context where `Atomics.wait` is permitted.
 */
export function supportsSync(): boolean {
  return !isMainThread;
}
