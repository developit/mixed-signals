---
'mixed-signals': minor
---

Generalize mixed-signals into a full RPC library with a three-tier
lifecycle model. Signals, Models, plain objects, functions, and Promises
all cross the wire with identity preserved, each using the minimum
machinery their kind requires.

**Three lifecycle tiers:**

- **Tier 1 — Signals.** Subscription is retention. `watched`/`unwatched` on
  `@preact/signals-core` drives `@W`/`@U` directly. No `FinalizationRegistry`,
  no `@D` release frames, no refcount. Works on every JS engine.
- **Tier 2 — Objects & Functions.** The only population that actually needs
  GC-observed refcounting. Client registers Proxies / callables with
  `FinalizationRegistry`; unreachable handles produce coalesced `@D`
  release batches. Server retention policy (`ttl` default 30s, `disconnect`,
  `weak`) governs final cleanup. `Symbol.dispose` on Proxies is a
  deterministic opt-in that short-circuits GC.
- **Tier 3 — Promises.** One-shot lifecycle. No refcount, no release path,
  no Handles entry — just a pid counter and a settlement closure. Worst
  case (client stops caring) is O(1) wasted frame.

**Upgrade rule for objects:**

An object becomes an `o` handle iff it's stamped by `createModel(name, \u2026)`
OR has at least one non-`_` method anywhere in its prototype chain (up to
but not including `Object.prototype`). Otherwise it's plain JSON.

Methods never appear in a handle's shape or data array — they're
trap-dispatched as `<id>#method` on demand. Two classes with identical
*state* but different *methods* share a shape.

**Other wire wins:**

- Unified `@H` marker with kind-tagged id (`s`/`o`/`f`/`p`).
- Shape cache: first emission inline, subsequent bare refs.
- Model-name cache: name crosses the wire once per client, then id refs.
- Brand-aware `JSON.stringify` replacer on the client: passing a hydrated
  value back to the server resolves to the original live object by id.
- `.toJSON()` short-circuit: Date and user-defined opt-outs serialize
  as their plain representation, matching `JSON.stringify` semantics.

**Breaking changes:**

- `createModel(factory)` \u2192 `createModel(name, factory)` — name is required,
  stamped on the constructor via a registered symbol.
- `createReflectedModel(props, methods)` is a deprecated no-op.
- `RPC#registerModel` / `RPCClient#registerModel` removed.
- Wire protocol bumped. `@S` / `@M` markers replaced by unified `@H`. Both
  peers must update together.
