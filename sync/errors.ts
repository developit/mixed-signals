/**
 * Sync RPC error hierarchy. Every error inherits from `SyncRPCError` so
 * user code can match the whole family with a single `instanceof` check:
 *
 *   try {
 *     rpc.wait([rpc.root.foo()]);
 *   } catch (e) {
 *     if (e instanceof SyncRPCError) { ... }
 *   }
 *
 * Each class sets `.name` via a string literal in the constructor so the
 * stable identifier survives minification and is reachable across realms
 * (`e.name === 'SyncRPCTimeoutError'`).
 */
export class SyncRPCError extends Error {
  override name = 'SyncRPCError';
}

/**
 * The current context is not cross-origin isolated, so `SharedArrayBuffer`
 * is unavailable and sync RPC cannot operate. Configure COOP `same-origin`
 * + COEP `require-corp` on every context in the chain.
 */
export class SyncRPCNotCrossOriginIsolatedError extends SyncRPCError {
  override name = 'SyncRPCNotCrossOriginIsolatedError';
}

/**
 * The current context cannot be the caller side of a sync RPC. Covers main
 * threads (browsers and Node), ServiceWorkers, and any environment without
 * `SharedArrayBuffer`. Use a browser DedicatedWorker / SharedWorker or a
 * Node `worker_threads` worker instead.
 */
export class SyncRPCUnsupportedContextError extends SyncRPCError {
  override name = 'SyncRPCUnsupportedContextError';
}

/**
 * The host did not respond within `opts.timeoutMs`. The lane is quarantined
 * (caller side); subsequent sync calls on the same client will fail until
 * the connection is rebuilt.
 */
export class SyncRPCTimeoutError extends SyncRPCError {
  override name = 'SyncRPCTimeoutError';
}

/**
 * A `SyncablePromise` was consumed twice — typically by `await` (or
 * `.then`/`.catch`/`.finally`) followed by `rpc.wait`, or vice versa, or
 * by `rpc.wait` after the auto-fire microtask has already fired the async
 * send. Each promise has exactly one consumer.
 */
export class SyncRPCAlreadyWaitedError extends SyncRPCError {
  override name = 'SyncRPCAlreadyWaitedError';
}

/**
 * `rpc.wait(...)` was called on a client whose transport does not
 * implement the optional `wait?` method. Configure the client with a
 * sync-capable transport before calling `rpc.wait(...)`.
 */
export class SyncRPCNoTransportWaitError extends SyncRPCError {
  override name = 'SyncRPCNoTransportWaitError';
}

/**
 * A method invoked on a sync-blocked client tried to call back into the
 * same client — a reentrant call that would deadlock the `Atomics.wait`.
 * The wrapper rejects the offending invocation synchronously.
 */
export class SyncRPCReentrancyError extends SyncRPCError {
  override name = 'SyncRPCReentrancyError';
}

/**
 * Setup or operation of an iframe bridge failed: missing
 * `crossOriginIsolated` on a context in the chain, a SAB transfer
 * rejected at the agent-cluster boundary, a sandboxed iframe missing
 * `allow-same-origin`, etc. The error message identifies the specific
 * misconfiguration.
 */
export class SyncRPCIframeBridgeError extends SyncRPCError {
  override name = 'SyncRPCIframeBridgeError';
}

/**
 * A single call's encoded arguments exceed the data SAB's capacity. With
 * a default 64 KiB data SAB (max 256 KiB), a request envelope whose JSON
 * encoding is larger than the configured size cannot be transmitted even
 * with chunking — a single chunk is bounded by the SAB. Use a smaller
 * request shape, or configure a larger `dataSabSize` at sync-server setup
 * (up to the 256 KiB ceiling).
 */
export class SyncRPCPayloadTooLargeError extends SyncRPCError {
  override name = 'SyncRPCPayloadTooLargeError';
}
