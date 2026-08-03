---
"mixed-signals": patch
---

Fix object deltas silently dropping key removals.

`Reflection#computeDelta` only iterated the new value's keys when building a
`merge` delta, so a key removed at the same time as any other change was never
sent to the client — and the client's additive `{...current, ...value}` merge
kept the stale key until the next full replacement. The object branch now
scans the previous value's keys first and falls back to a full replacement
whenever any key leaves the wire — removed outright, or set to a value
serialization drops (`undefined`, a function, or a symbol) — since a merge
delta cannot
express deletion. Keys whose values were never serialized don't force a
replacement when they disappear. Pure additions and value changes still
produce `merge` deltas, and identical rebuilt objects still produce no
update.

Also removes the unsound key-count heuristic (one removal plus one addition
kept counts equal), standardizes key iteration and membership on own keys
(`Object.keys`/`Object.hasOwn`, so removals of keys shadowing
`Object.prototype` properties like `toString` are detected), and guards the
object branch against array new-values so an object-to-array transition sends
a full replacement instead of a bogus merge of array indices. The client's
`reconcileRoot` had the same prototype-chain membership check, which let a
removed root key shadowing an `Object.prototype` property survive
reconciliation on reconnect; it now uses `Object.hasOwn` as well.
