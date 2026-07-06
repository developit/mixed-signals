---
"mixed-signals": patch
---

Store server reflection signals and instance registry entries behind weak cache references, clear per-client last-sent values on unwatch, and avoid retaining per-client model marker histories across serialization calls.
