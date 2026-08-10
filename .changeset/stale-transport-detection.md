---
'mixed-signals': patch
---

Detect stale transports on the client. If a call is left waiting while no inbound frames arrive for `staleTimeout` (default 30s), `RPCClient` treats the transport as disconnected: pending calls reject, the disconnect lifecycle runs, and the transport's new optional `close()` is called. This catches half-open connections (a browser WebSocket after laptop sleep, NAT expiry, or an ungraceful server death) that never fire `onClose` and previously left calls pending forever. Tune or disable with `new RPCClient(transport, ctx, {staleTimeout})`.
