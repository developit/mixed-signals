---
'mixed-signals': minor
---

Confirm optimistic changes by mutation identity instead of value comparison.

The server echoes the wire call id on the deltas a call produces, to that call's originating client only, and `optimistic()` tags its patches with the same id. A change is confirmed when its id is echoed rather than when the base value happens to diverge. A server side normalization of the user's own edit therefore confirms and displays, and a concurrent write from another client no longer masquerades as confirmation. Concurrent writes are reported through a new `onConflict` callback, and the optimistic value keeps shadowing until the change is confirmed, so an unconfirmed edit is never overwritten on screen by a concurrent value. Value comparison remains the fallback when no id is present, so an existing server continues to work unchanged.

Delta application is no longer able to wedge a signal. A transform or an `until` predicate that throws against a concurrently changed base is dropped and reported through `onError` instead of propagating out of the read loop, and rows a key function cannot key are skipped rather than throwing.

`optimistic()` accepts an optional third argument carrying `onSettle`, `onError`, and `onConflict`, and the returned handle exposes `state` as one of `pending`, `settled`, `failed`, or `rolledback`.

`reconnect()` now rejects in-flight calls with `TransportClosedError`, distinguishing an unknown outcome from a server rejection so callers can retry idempotently.

A signal update that removes an object key is sent as a full replacement, since a merge delta cannot express deletion and previously left the removed key in place on the client.

Signal writes made during a server method call are now coalesced. The body of each call runs inside a batch, so a method that writes the same signal more than once emits a single delta carrying the final value instead of one delta per write. Code that relied on observing every intermediate write as its own delta will now see fewer of them.

Two reflected types are tightened. `Immutable<T>` now exposes a nested reflected signal as `ReadonlySignal`, so a transform can no longer write it. `ChangeOptions` is non-distributive, so a union-typed array signal resolves as one option shape rather than splitting. Both can surface as new compile errors in code that relied on the looser types.
