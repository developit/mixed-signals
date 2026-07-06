---
"mixed-signals": patch
---

Store client reflection signals and reflected model facades behind weak cache references so unwatched, otherwise-unheld client-side identities can be garbage collected without losing identity preservation for objects still held by application code.
