# mixed-signals

## 0.3.0

### Minor Changes

- aedce03: Add support for server->client RPC calls that mirrors the client->server RPC mechanism just in reverse.

  ```js
  client.expose({
    browser: {
      logs: () => ["blah"],
    },
  });
  ```

  ### Protocol Changes

  The server->client RPC protocol works identically to the existing client->server RPC call mechanism, just in reverse:

  - an inbound `M{id}:method:args` frame is dispatched against the exposed root
  - methods are looked up using the same dot-notation lookup the server uses for nested method calls, so `browser.logs` walks `root.browser.logs` and invokes it with `this` bound to the immediate receiver.
  - Returning a value sends `R{id}`; throwing or rejecting sends `E{id}` with the `{code:-1, message}` shape the server already uses.
  - Unknown methods get a structured error back instead of silent drop

### Patch Changes

- 32ed3f6: Fix positional-argument shifting when a middle argument is `undefined`. Previously `[1, undefined, 3]` encoded as `1,,3` — invalid JSON that failed to parse on the receiving side. Now encoded as `1,null,3` so positions are preserved (the `undefined` is coerced to `null` per standard JSON semantics).

## 0.2.1

### Patch Changes

- 8db8e3e: add reconnection support to RPCClient and ClientReflection
- aba6e25: fix: bind existing clients when addUpstream() is called after addClient()
