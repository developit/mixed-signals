# mixed-signals

General-purpose RPC built on [Preact Signals and Models]: access reactive
model state, call arbitrary methods, and pass functions, Promises, and live
objects across a transport as if they lived locally. Zero manual registration
on either side, automatic refcounted cleanup, transport-agnostic.

[Preact Signals and Models]: https://github.com/preactjs/signals

**Installation:**

```sh
npm install mixed-signals
```

Peer dependency: `@preact/signals-core` (≥1.14.0).

## How it works

**mixed-signals** reflects server-side values to connected clients in
real-time. On the wire, every structural reference is a `Handle` with a
kind prefix (`s` signal, `o` object, `f` function, `p` promise). The client
hydrates handles into Proxies, live Signals, callable stubs, and live
Promises — all branded so when you pass them back to the server, the
original object is resolved by id.

- **Server** `createModel(name, factory)` stamps a named ctor; plain objects
  work too, no registration required.
- **Client** uses zero API: `new RPCClient(transport)` — every incoming
  value hydrates automatically.
- **Reactivity is the subscription protocol.** The server only subscribes to
  a source signal once a client is actually reading it; if no one watches,
  no push happens.
- **Refcounts + `FinalizationRegistry`** free server state automatically when
  client references go out of scope. No `dispose()`, ever.

## Full example

### `server.ts`

```ts
import { WebSocketServer } from "ws";
import { signal } from "@preact/signals-core";
import { RPC, createModel } from "mixed-signals/server";

const Todo = createModel("Todo", (_text = "") => {
  const text = signal(_text);
  const done = signal(false);
  const toggle = () => { done.value = !done.value; };
  return { text, done, toggle };
});

const Todos = createModel("Todos", () => {
  const all = signal<InstanceType<typeof Todo>[]>([]);
  function add(text: string) {
    const todo = new Todo(text);
    all.value = [...all.value, todo];
    return todo;
  }
  return { all, add };
});

const rpc = new RPC({ todos: new Todos() });

const wss = new WebSocketServer();
wss.on("connection", (ws) => {
  const dispose = rpc.addClient({
    send: ws.send.bind(ws),
    onMessage: ws.on.bind(ws, "message"),
  });
  ws.on("close", dispose);
});
```

### `client.tsx`

```tsx
import { useSignal } from "@preact/signals";
import { RPCClient } from "mixed-signals/client";

const ws = new WebSocket("/rpc");
const rpc = new RPCClient({
  send: ws.send.bind(ws),
  onMessage: ws.addEventListener.bind(ws, "message"),
  ready: new Promise((r) => ws.addEventListener("open", r, { once: true })),
});

function Demo() {
  const text = useSignal("");

  function add(e) {
    e.preventDefault();
    rpc.root.todos.add(text.value);
    text.value = "";
  }

  return <>
    <ul>
      {rpc.root.todos.all.value.map((todo) => (
        <li key={todo.id?.value}>
          <input type="checkbox" checked={todo.done.value}
                 onChange={() => todo.toggle()} />
          {todo.text.value}
        </li>
      ))}
    </ul>
    <form onSubmit={add}>
      <input value={text} onInput={e => text.value = e.currentTarget.value} />
    </form>
  </>;
}

await rpc.ready;
render(<Demo />, document.body);
```

Notice what's missing: no `createReflectedModel`, no `registerModel`, no
explicit method list. Every incoming value is a Proxy that synthesizes method
calls on first access.

## Handles: what crosses the wire

| Value                                       | Wire | Tier | Release mechanism                  | Client rehydrates as                                 |
| ------------------------------------------- | ---- | ---- | ---------------------------------- | ---------------------------------------------------- |
| `signal(x)`                                 | `s`  | 1    | `@W`/`@U` subscription (no GC)     | live `Signal`                                        |
| `new Model()` (via `createModel(name, …)`) | `o`  | 2    | refcount + `FinalizationRegistry`  | `Proxy` with `typeName`, signal props, method trap   |
| class instance with methods (no createModel)| `o`  | 2    | same                               | same, no `typeName`                                  |
| plain object with at least one method       | `o`  | 2    | same                               | same, no `typeName`                                  |
| plain object of pure data (no methods)      | —    | —    | none — pass-by-value                | plain JS object                                      |
| function                                    | `f`  | 2    | refcount + `FinalizationRegistry`  | callable `Proxy` that RPCs to the server             |
| `Promise` (pending)                         | `p`  | 3    | one-shot `@P`/`@E` settlement      | live `Promise`                                       |
| `Promise` (already settled)                 | —    | —    | none                               | the resolved value inline                            |

### What each tier means for you

- **Tier 1 (signals)** — subscription *is* retention. No GC needed; works
  on every JS engine. The server only holds a live `.subscribe(...)` while
  a client is `@W`-watching.
- **Tier 2 (objects, functions)** — the client's `FinalizationRegistry`
  observes unreachable Proxies / callables and batches `@D` release
  frames. Server decrements refcounts; retention policy handles cleanup
  once they hit zero.
- **Tier 3 (promises)** — one settlement frame, no refcount, no release.
  A Promise the client stopped caring about is O(1) wasted frame.

### Identity round-trip

When you pass a hydrated value back to the server (as a method argument,
a callback receiver, anything), the client's `JSON.stringify` replacer
detects the hidden brand and emits `{"@H":"<id>"}`. The server resolves
that to the original live object. **`===` identity is preserved end to
end, no user API needed.**

## Retention policies (tier 2 only)

Configure on the server constructor. Only affects `o` and `f` handles;
signals and promises have their own lifecycles.

```ts
new RPC(root, { retention: { kind: "ttl", idleMs: 30_000 } }); // default
new RPC(root, { retention: { kind: "disconnect" } });
new RPC(root, { retention: { kind: "weak" } });
```

- **`ttl`** (default, 30s idle) — once a handle has zero refs, a sweep clocks
  when its last activity was and drops it after `idleMs`. Any touch (new
  emission, method call, reconnection) resets the clock. Default because it
  tolerates reconnects.
- **`disconnect`** — handles stay until the client disconnects; on disconnect
  everything orphaned is dropped.
- **`weak`** — orphaned handles drop immediately. Use when your domain layer
  owns the lifecycle and RPC is just reflecting live objects.

No manual disposal API. On environments with `FinalizationRegistry`,
clients send `@D` release frames as Proxies become unreachable. On older
engines, the chosen retention policy is the sole cleanup mechanism.

### Deterministic dispose via `Symbol.dispose`

```ts
{
  using project = await rpc.root.getProject('42');
  // … use project
} // on scope exit, Symbol.dispose fires → immediate @D release
```

Or explicitly: `project[Symbol.dispose]()`. Short-circuits GC and is
entirely optional.

## API

_Generated from TypeScript declarations._

### `mixed-signals/server`

#### `createModel(name, factory)`

- Kind: **Function**
- Signatures:
  - `(name: string, factory: ModelFactory<TModel, TFactoryArgs>) => ModelConstructor<TModel, TFactoryArgs>`

The name is required. It is stamped on the constructor and surfaces on the
client as `typeOfRemote(proxy) === name`.

#### `RPC`

- Constructor:
  - `new RPC(root?: any, options?: { retention?: RetentionPolicy }) => RPC`
- Methods:
  - `addClient(transport: Transport, clientId?: string) => () => void`
  - `addUpstream(transport: Transport) => () => void` — forward another
    mixed-signals connection transparently.
  - `expose(root: any) => void`
  - `notify(method: string, params: any[], clientId?: string) => void`

#### `typeOfRemote(value)`

- Kind: **Function**
- Returns the Model type name for a hydrated Proxy, or `undefined` if the
  value wasn't created via `createModel`.

### `mixed-signals/client`

#### `RPCClient`

- Constructor: `new RPCClient(transport: Transport) => RPCClient`
- Methods:
  - `call(method: string, params?: any[]) => Promise<any>`
  - `notify(method: string, params?: any[]) => void`
  - `onNotification(cb: (method: string, params: any[]) => void) => () => void`
  - `reconnect(transport: Transport) => void`
- Properties:
  - `ready: Promise<void>`
  - `root: any`

#### `typeOfRemote(value)`

- Same as the server export; works on any hydrated Proxy.

### Shared

#### `Transport`

```ts
interface Transport {
  send(data: string): void;
  onMessage(cb: (data: { toString(): string }) => void): void;
  ready?: Promise<void>;
}
```

## Migration from 0.2.x

- `createReflectedModel(signalProps, methods)` is a deprecated no-op; delete
  all client-side model declarations.
- `RPCClient#registerModel` and `RPC#registerModel` no longer exist.
- `createModel(factory)` → `createModel(name, factory)` (name is now
  required). This is the one breaking change in authoring ergonomics.
- `@S` / `@M` wire markers have been replaced by a single `@H` marker. This
  is a wire-level protocol bump; both sides must update together.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the deeper design.
