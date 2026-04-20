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
  no Handles entry — just a pid counter and a settlement closure.

**Upgrade rule for objects:**

An object becomes an `o` handle iff it's stamped by `createModel(name, …)`
OR has at least one non-`_` method anywhere in its prototype chain (up to
but not including `Object.prototype`). Otherwise it's plain JSON.

Methods never appear in a handle's shape or data — they're
trap-dispatched as `<id>#method` on demand.

**Wire format:**

- Unified `@H` marker with kind-tagged id (`s`/`o`/`f`/`p`).
- Class cache per connection: first emission carries class def inline
  (`c:"<id>#<name>"`, `p:"key1,key2"`); subsequent emissions use a numeric
  `c` ref and skip `p`. Class name is folded into `c` with `#` separator.
- `d` is a positional array for cached-class instances, a keyed object
  for ad-hoc handles (plain objects with methods).
- Brand-aware `JSON.stringify` replacer on the client: passing a hydrated
  value back to the server resolves to the original live object by id.
- `.toJSON()` short-circuit: Date and user-defined opt-outs serialize
  as their plain representation, matching `JSON.stringify` semantics.

**Client `instanceof` support:**

Every cached class allocates a synthetic ctor on the client; instances
are built as `Object.create(ctor.prototype)`. Use `client.classOf(name)`
to get the ctor and check membership:

```ts
const Counter = client.classOf('Counter');
value instanceof Counter; // true across all server-emitted Counters
```

**Breaking changes:**

- `createModel(factory)` → `createModel(name, factory)` — name is required,
  stamped on the constructor via a registered symbol.
- `createReflectedModel(props, methods)` is a deprecated no-op.
- `RPC#registerModel` / `RPCClient#registerModel` removed.
- Wire protocol is incompatible with earlier versions. Both peers must
  update together.
- `shared/shapes.ts` and `SHAPE_FIELD` / `MODEL_NAME_FIELD` constants are
  removed; kinds are no longer transmitted. All class metadata is carried
  by the single `c` field.
