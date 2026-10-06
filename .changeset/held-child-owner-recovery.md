---
"mixed-signals": patch
---

Recover observed child models through their unobserved parents when the server cannot resolve the children directly, after a reconnect or when an idle child is observed again.
Parent refreshes are deduplicated across children and in-flight requests, and recovery retains marker relationships without retaining parent facades.
The server sends a model in full again after a refresh of its marker did not resolve.
