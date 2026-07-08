---
"mixed-signals": patch
---

Fix signal watch batching by consolidating to a single global debounce window.

`ClientReflection` now uses one shared static timer for watch/unwatch flushes
across all instances, instead of two per-instance timers. Watch and unwatch
batches are flushed together by `flushWatches()`, and `scheduleWatch`/
`scheduleUnwatch` each remove the signal id from the opposite pending batch,
fixing a latent race where the same id could be flushed as both a watch and an
unwatch in the same tick. A new `watchedSignals` set tracks which signals are
actually subscribed so redundant watch/unwatch RPC messages are no longer sent,
and the per-signal debounce timer in `getOrCreateSignal()` has been removed in
favour of the global 10ms flush window.
