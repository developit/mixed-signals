---
"mixed-signals": minor
---

Reflect client models with Proxy facades by default.

Clients no longer have to register every server model type with
`createReflectedModel(signalProps, methods)`. The `@M` payload already includes
the model wire id plus the serialized signal properties for that instance, so
`RPCClient` now creates a cached Proxy facade automatically when no custom
constructor is registered. Signal properties are discovered from the payload and
exposed as computed read-only signals, while unknown method properties become
stable lazy RPC call functions that reject with the server's method-not-found
error if the method does not exist.

`createReflectedModel()` and `registerModel()` remain available for custom or
legacy facades, but model registration is no longer required for safe root model
rollouts.
