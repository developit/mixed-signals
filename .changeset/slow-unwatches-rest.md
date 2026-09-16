---
"mixed-signals": patch
---

Defer client signal unwatch notifications for up to one second while keeping
watch notifications on their existing 10ms global batching window. Rewatching
a signal removes it from the pending unwatch queue, avoiding redundant
watch/unwatch/watch traffic during transient unmount and remount cycles without
slowing the watches needed for initial and catch-up delta delivery.
