---
'mixed-signals': minor
---

Identify signals owned by a model by its model marker and property name instead of allocating a separate signal ID. Require explicit watches for updates, notify clients when registered models are deleted, and forget client-side identities after garbage collection so later sends include full values.
