---
'mixed-signals': minor
---

Add `rpc.markFinal(...signals)` to promise clients a signal will never change
again. Final signals serialize as `{"@S": id, "v": value, "f": 1}`: the client
still gets a `Signal`, but observing it sends no `@W` and the server never
subscribes to it. A signal that becomes final while clients watch it is
announced with a new `N:@F:id,...` notification, which forwarding relays.
Old clients ignore both and keep watching as before.
