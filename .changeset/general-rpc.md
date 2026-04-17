---
'mixed-signals': minor
---

Generalize mixed-signals into a full RPC library while keeping Signal/Model
reactivity as a first-class special case.

**New:**

- Unified handle model on the wire (`@H` marker with `s`/`o`/`f`/`p` kinds).
  Signals, Models, plain objects, functions, and Promises all cross the wire
  with stable identity.
- Proxy-based hydration on the client. No more `createReflectedModel(props, methods)`;
  every remote value is a `Proxy` that synthesizes method calls on unknown keys
  and carries a hidden brand so it round-trips back to the owning peer by id.
- Shape cache. Object wire payloads collapse to `{@H:"o17",s:3,n:2,d:[...]}`
  after warm-up — no repeated key names, no repeated model names, significant
  bandwidth win for long-lived sessions.
- Function handles. Server-returned functions become callable Proxies on the
  client; invoking them round-trips to the server.
- Promise handles. Server-returned pending Promises become live Promises on
  the client, settled by `@P`/`@PE` when the server resolves/rejects them.
- Retention policies (`ttl` default, 30s idle; `disconnect`; `weak`). No
  manual disposal anywhere. `FinalizationRegistry` drives release batches
  client → server.
- `typeOfRemote(proxy)` introspection helper for getting the Model name of a
  hydrated value.

**Breaking changes:**

- `createModel(factory)` → `createModel(name, factory)`. The name is now
  required and stamped on the constructor.
- `createReflectedModel(props, methods)` is a deprecated no-op. Delete
  client-side model declarations — they are no longer needed.
- `RPC#registerModel` / `RPCClient#registerModel` removed.
- Wire protocol bumped. `@S` / `@M` markers replaced by unified `@H`. Both
  sides must update together.
