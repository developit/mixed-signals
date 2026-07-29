# mixed-signals

## 0.4.1

### Patch Changes

- 39e2ae8: Exclude local symbol members from reflected object types so signals-core model lifecycle symbols do not appear as remote facade properties.
- 6040145: Fix re-watch staleness, harden method dispatch, and expose nested model facades.

  - `Reflection.watch()` now sends a catch-up delta when a client (re)joins a signal subscription that another client kept alive. Previously the re-watching client stayed stale until the signal next changed — permanently, if it never changed again.
  - `RPC` method dispatch rejects underscore-prefixed path segments, `constructor`/`prototype`/`__proto__`, and methods inherited from `Object.prototype`, so wire calls can only reach the intentionally exposed graph.
  - Proxy facades now define nested reflected models as real properties (e.g. `task.vcs` is the nested model's facade) instead of dropping them and returning a method proxy.
  - Call rejections now preserve application error properties: own enumerable props on a thrown error (e.g. a machine-readable `code`) ride the error frame and are restored onto the client-side rejection.
  - `getInstanceId` rejects model ids containing `#` or `:` — both are wire-format delimiters, and such ids previously corrupted call frames silently.
  - Added a `prepare` script so git-pinned installs build automatically. The tsdown config is now plain `.mjs` so that build never asks Node to type-strip a `.ts` file — package managers prepare git deps under `node_modules` paths, where Node refuses type stripping (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).

## 0.4.0

### Minor Changes

- 986645a: Add process-aware reconnect support that keeps client roots, signals, and reflected model facades alive across transport replacement, refreshes them from the next root snapshot, refreshes active held model facades that are not reachable from the reconnect root, lazily refreshes stale held facades when they become watched after a process change, replays active signal subscriptions, treats missing connection metadata as an unknown process for legacy servers, and exposes server connection metadata for process identity and retained-state resumes.
- 10ab82e: Reflect client models with Proxy facades by default.

  Clients no longer have to register every server model type with
  `createReflectedModel(signalProps, methods)`. The `@M` payload already includes
  the model wire id plus the serialized signal properties for that instance, so
  `RPCClient` now creates a cached Proxy facade automatically when no custom
  constructor is registered. Signal properties are discovered from the payload and
  exposed as computed read-only signals, while unknown method properties become
  stable lazy RPC call functions that reject with the server's method-not-found
  error if the method does not exist.

  `createReflectedModel()` and `registerModel()` remain available for custom or
  legacy facades, but model registration is no longer required for safe root model
  rollouts.

### Patch Changes

- e547760: Fix signal watch batching by consolidating to a single global debounce window.

  `ClientReflection` now uses one shared static timer for watch/unwatch flushes
  across all instances, instead of two per-instance timers. Watch and unwatch
  batches are flushed together by `flushWatches()`, and `scheduleWatch`/
  `scheduleUnwatch` each remove the signal id from the opposite pending batch,
  fixing a latent race where the same id could be flushed as both a watch and an
  unwatch in the same tick. A new `watchedSignals` set tracks which signals are
  actually subscribed so redundant watch/unwatch RPC messages are no longer sent,
  and the per-signal debounce timer in `getOrCreateSignal()` has been removed in
  favour of the global 10ms flush window.

- 97f8c2b: Store client reflection signals and reflected model facades behind weak cache references so unwatched, otherwise-unheld client-side identities can be garbage collected without losing identity preservation for objects still held by application code.

## 0.3.0

### Minor Changes

- aedce03: Add support for server->client RPC calls that mirrors the client->server RPC mechanism just in reverse.

  ```js
  client.expose({
    browser: {
      logs: () => ["blah"],
    },
  });
  ```

  ### Protocol Changes

  The server->client RPC protocol works identically to the existing client->server RPC call mechanism, just in reverse:

  - an inbound `M{id}:method:args` frame is dispatched against the exposed root
  - methods are looked up using the same dot-notation lookup the server uses for nested method calls, so `browser.logs` walks `root.browser.logs` and invokes it with `this` bound to the immediate receiver.
  - Returning a value sends `R{id}`; throwing or rejecting sends `E{id}` with the `{code:-1, message}` shape the server already uses.
  - Unknown methods get a structured error back instead of silent drop

### Patch Changes

- 32ed3f6: Fix positional-argument shifting when a middle argument is `undefined`. Previously `[1, undefined, 3]` encoded as `1,,3` — invalid JSON that failed to parse on the receiving side. Now encoded as `1,null,3` so positions are preserved (the `undefined` is coerced to `null` per standard JSON semantics).

## 0.2.1

### Patch Changes

- 8db8e3e: add reconnection support to RPCClient and ClientReflection
- aba6e25: fix: bind existing clients when addUpstream() is called after addClient()
