---
"mixed-signals": patch
---

Refresh held models through `@M` before resubscribing after their last field is unwatched or after reconnect while unobserved, including reconnects to the same server process.
Keep existing facade and signal identities, coalesce refreshes, and avoid subscribing to stale signal ids when refresh fails or the observer leaves.
Sealed signals remain final.
