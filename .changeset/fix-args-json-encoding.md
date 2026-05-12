---
'mixed-signals': patch
---

Fix positional-argument shifting when a middle argument is `undefined`. Previously `[1, undefined, 3]` encoded as `1,,3` — invalid JSON that failed to parse on the receiving side. Now encoded as `1,null,3` so positions are preserved (the `undefined` is coerced to `null` per standard JSON semantics).
