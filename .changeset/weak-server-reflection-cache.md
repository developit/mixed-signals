---
"mixed-signals": patch
---

Store server reflection signals and instance registry entries behind weak cache references, subscribe only after explicit client watches, register live identities with finalizers once, avoid retaining model or forwarded-signal histories, and release pending forwarding state when an upstream closes.
