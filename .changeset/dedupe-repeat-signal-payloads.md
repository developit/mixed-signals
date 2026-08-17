---
"mixed-signals": patch
---

Stop re-sending signal values a client already holds.

Serializing a signal always inlined its value, so anything that reached a client
twice was paid for twice. Returning a reflected signal from an RPC method — the
natural way to answer "give me the diff" without a second copy of it — sent the
whole payload again alongside the update the client had already received. In a
real app that was a 474 KB diff crossing the wire twice in adjacent frames.

`Reflection` now emits a bare `{'@S': id}` ref when it can prove the client
already holds that exact value: the last value sent to that client is
identical, and the client still has a live subscription to the signal. Watched
signals are strongly held on the client, so a subscription rules out the signal
having been collected out of its `WeakRef` cache and the ref failing to resolve.
The client half already handled `v`-less refs, so no client change was needed.

Refreshing a model by marker still re-inlines its own signals — a refresh means
the client stopped trusting its copy, and a ref back to that copy is worthless.
