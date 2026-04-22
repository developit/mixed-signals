---
'mixed-signals': patch
---

Preserve `undefined` across the wire. Calls with `undefined` arguments previously produced invalid JSON (`1,,3`) that failed to parse on the receiving side; results set to `undefined` produced the literal `R4:undefined`, also invalid. Both now encode through a tagged-object sentinel (`{"@u":1}`) — matching the existing `@S`/`@M` convention — so `undefined` roundtrips as `undefined` (distinct from `null`) for params, notifications, and results.
