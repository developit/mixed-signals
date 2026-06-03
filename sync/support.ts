/**
 * Browser-side `supportsSync()` detector.
 *
 * Returns `true` only in browser DedicatedWorker / SharedWorker
 * contexts that are cross-origin-isolated. Returns `false` in:
 *
 *   - browser main threads (`Window` present and identical to
 *     `globalThis`)
 *   - ServiceWorkers (`ServiceWorkerGlobalScope` present)
 *   - any context missing `SharedArrayBuffer` or `Atomics`
 *   - browser worker contexts where `crossOriginIsolated === false`
 *
 * This file is the *browser* implementation. The Node-side
 * implementation lives in `support.node.ts`; consumers reach the
 * platform-appropriate version through the `mixed-signals/sync`
 * package's `node` subpath conditional export. Tests can also
 * import either file directly.
 *
 * Returns `false` from any non-browser host (e.g. a Node main
 * thread that ended up loading this entry by accident). The Node
 * detection lives in `support.node.ts` and is the path callers
 * should reach in Node.
 */
export function supportsSync(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  if (typeof Atomics === 'undefined') return false;

  if (typeof globalThis === 'undefined') return false;
  const g = globalThis as unknown as Record<string, unknown>;

  // ServiceWorker — explicit no. Includes `ServiceWorkerGlobalScope`
  // detection across all browsers that expose it.
  if (typeof g.ServiceWorkerGlobalScope !== 'undefined') return false;

  // Main thread — `window` identical to `globalThis` is the
  // canonical main-thread signal in browsers.
  const hasWindow = typeof g.window !== 'undefined' && g.window === g;
  if (hasWindow) return false;

  // Worker scope — must additionally pass the COI check.
  const hasWorkerScope = typeof g.WorkerGlobalScope !== 'undefined';
  if (hasWorkerScope) {
    if ('crossOriginIsolated' in g && g.crossOriginIsolated === false) {
      return false;
    }
    return true;
  }

  // Neither browser main thread nor browser worker — the Node
  // detection path is at `support.node.ts`. We return false here so
  // a Node host that wrongly loaded this entry doesn't claim
  // capability it can't actually deliver.
  return false;
}
