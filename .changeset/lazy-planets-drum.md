---
"mixed-signals": patch
---

Simplify client-side watch/unwatch batching and fix a watch/unwatch race.

`ClientReflection` no longer creates a per-signal `setTimeout` on every
`watched()`/`unwatched()` call. Watch and unwatch batches are flushed by a
single shared 10ms timer, and `scheduleWatch`/`scheduleUnwatch` each remove
the signal id from the opposite pending batch, so a quick remount cancels
the pending unwatch (or vice versa) for free. This also fixes a latent bug
where `watchBatch` and `unwatchBatch` were tracked independently, making it
possible to flush a batched watch and a batched unwatch for the same signal
id in the same tick.
