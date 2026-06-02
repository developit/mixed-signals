/**
 * Capability check: can this context be the *caller* side of a sync RPC?
 *
 * Returns `false` in:
 *   - browser main threads (`Window` global present)
 *   - ServiceWorkers (`ServiceWorkerGlobalScope`)
 *   - any context without `SharedArrayBuffer` or `Atomics`
 *   - browser contexts that aren't `crossOriginIsolated`
 *   - Node main threads (`worker_threads.isMainThread === true`)
 *
 * Returns `true` in browser DedicatedWorker / SharedWorker and Node
 * `worker_threads` workers under cross-origin isolation.
 *
 * Node worker detection is best-effort in this browser-neutral bundle.
 * It relies on a CommonJS `require` global being present alongside
 * `node:worker_threads`; pure ESM Node contexts where `require` is
 * unavailable conservatively return `false`. Consumers that need
 * reliable Node-side detection should use the Node-specific entrypoint.
 */
export function supportsSync(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  if (typeof Atomics === 'undefined') return false;

  // Browser path.
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as unknown as Record<string, unknown>;

    // ServiceWorker — explicit no.
    if (typeof g.ServiceWorkerGlobalScope !== 'undefined') return false;

    // Worker context: has `WorkerGlobalScope`, lacks `window === globalThis`.
    const hasWorkerScope = typeof g.WorkerGlobalScope !== 'undefined';
    const hasWindow = typeof g.window !== 'undefined' && g.window === g;

    if (hasWindow) return false; // main thread

    if (hasWorkerScope) {
      // Browser worker: also require crossOriginIsolated.
      if ('crossOriginIsolated' in g && g.crossOriginIsolated === false) {
        return false;
      }
      return true;
    }
  }

  // Node path: only reach here if no worker scope was detected above.
  // Read `process` and `require` off `globalThis` with `unknown` typing
  // so this module compiles without `@types/node` and so browser bundles
  // (where neither global exists) short-circuit cleanly.
  const g = globalThis as unknown as {
    process?: {versions?: {node?: string}};
    require?: (id: string) => unknown;
  };
  if (
    typeof g.process !== 'undefined' &&
    typeof g.process.versions?.node === 'string'
  ) {
    try {
      // Synchronous `require` resolves `node:worker_threads` without
      // forcing this function to be async. Reached only when running in
      // CJS-compatible Node; pure-ESM Node bundles have no `require`
      // global and short-circuit to the trailing `false`.
      const wt = g.require?.('node:worker_threads') as
        | {isMainThread?: boolean}
        | undefined;
      if (wt && typeof wt.isMainThread === 'boolean') {
        return !wt.isMainThread;
      }
    } catch {
      // fall through
    }
  }

  return false;
}
