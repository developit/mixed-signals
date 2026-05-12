---
'mixed-signals': minor
---

Add support for server->client RPC calls that mirrors the client->server RPC mechanism just in reverse.

```js
client.expose({
  browser: {
    logs: () => ['blah']
  }
});
```

### Protocol Changes

The server->client RPC protocol works identically to the existing client->server RPC call mechanism, just in reverse:
- an inbound `M{id}:method:args` frame is dispatched against the exposed root
- methods are looked up using the same dot-notation lookup the server uses for nested method calls, so `browser.logs` walks `root.browser.logs` and invokes it with `this` bound to the immediate receiver.
- Returning a value sends `R{id}`; throwing or rejecting sends `E{id}` with the `{code:-1, message}` shape the server already uses.
- Unknown methods get a structured error back instead of silent drop
