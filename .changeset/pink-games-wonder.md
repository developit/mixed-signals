---
"mixed-signals": patch
---

Fix re-watch staleness, harden method dispatch, and expose nested model facades.

- `Reflection.watch()` now sends a catch-up delta when a client (re)joins a signal subscription that another client kept alive. Previously the re-watching client stayed stale until the signal next changed — permanently, if it never changed again.
- `RPC` method dispatch rejects underscore-prefixed path segments, `constructor`/`prototype`/`__proto__`, and methods inherited from `Object.prototype`, so wire calls can only reach the intentionally exposed graph.
- Proxy facades now define nested reflected models as real properties (e.g. `task.vcs` is the nested model's facade) instead of dropping them and returning a method proxy.
- Call rejections now preserve application error properties: own enumerable props on a thrown error (e.g. a machine-readable `code`) ride the error frame and are restored onto the client-side rejection.
- `getInstanceId` rejects model ids containing `#` or `:` — both are wire-format delimiters, and such ids previously corrupted call frames silently.
- Added a `prepare` script so git-pinned installs build automatically. The tsdown config is now plain `.mjs` so that build never asks Node to type-strip a `.ts` file — package managers prepare git deps under `node_modules` paths, where Node refuses type stripping (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
