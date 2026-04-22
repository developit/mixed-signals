---
'mixed-signals': patch
---

Fix wire-protocol encoding of `undefined` arguments. Calls with `undefined` params previously produced invalid JSON (`1,,3`) that failed to parse on the receiving side; they now encode as `null` (`1,null,3`) following standard JSON semantics.
