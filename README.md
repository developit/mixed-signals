# mixed-signals

RPC + reflection for [Preact Signals and Models](https://github.com/preactjs/signals): access reactive model state and methods from a server (or worker/tab/etc) as if they lived on the client. Type-safe, minimal magic, and an optimized transport-agnostic protocol (WebSocket, SSE, postMessage, etc).

**Installation:**

```sh
npm install mixed-signals
```

The only dependency is `@preact/signals-core` (>=1.8.0).

## How it works

**mixed-signals** reflects server-side Preact Models and Signals (anything created via `@preact/signals-core`) to connected clients in real-time. Signals on the server are serialized with identity markers, and the client reconstructs them as local signals that stay in sync via a lightweight wire protocol.

- **Server** models use `createModel()` from `mixed-signals/server` _(a thin wrapper around `@preact/signals-core`'s `createModel`)_
- **Client** models use `createReflectedModel()` from `mixed-signals/client` to create local proxies that mirror server state
- An **RPC** layer handles method calls (client → server) and signal updates (server → client)
- Delta compression for arrays (append/splice), objects (merge), and strings (append) minimizes bandwidth

## Optimistic UI

Reflected signals are server-owned, but `optimistic()` lets you mutate the very signal the UI renders, at the call site, bound to the action that will make the change real. Nothing is declared ahead of time: the change is layered over the live signal, incoming server deltas keep updating a hidden base, and the overlay reconciles to the server-owned value once the action settles — or rolls back if it rejects.

```ts
import { optimistic } from "mixed-signals/client";

optimistic(session.send(text), (tx) => {
  tx.update({
    signal: session.messages,
    transform: (messages) => [...messages, localUserMessage],
    key: (message) => message.clientMutationId ?? message.id,
  });
});
```

`tx.set` replaces a value and `tx.update` derives the next one from a read-only view of the current value. Both take a single named-arguments object (`{ signal, value | transform, ... }`) and only accept reflected signals (`ReflectedSignal<T>`, produced by `createReflectedModel`), so passing a plain local signal is a compile error. Array changes must declare a primitive, unique `key` so inserts, deletes, replaces, and moves reconcile by element identity instead of by position. Optimistic inserts require an action promise; if the server never reflects the inserted key, the action settlement drops or rolls back the provisional item.

For optimistic inserts, the key must be present on the eventual server item as well, commonly via an app-level client mutation id echoed by the server. Without an action, drive non-insert lifecycles yourself with the returned `handle.rollback()`.

## Full Example

### `server.ts`

```ts
import { WebSocketServer } from "ws";
import { signal } from "@preact/signals-core";
import { RPC, createModel } from "mixed-signals/server";

const Todo = createModel((_text = "") => {
  const text = signal(_text);
  const done = signal(false);
  const toggle = () => done.value = !done.value;
  return { text, done, toggle };
});
type Todo = InstanceType<typeof Todo>;

const Todos = createModel(() => {
  const all = signal<Todo[]>([]);
  function add(text: string) {
    const todo = new Todo(text);
    all.value = [...all.value, todo];
    return todo;
  }
  return { all, add };
});
type Todos = InstanceType<typeof Todos>;

const todos = new Todos();
const rpc = new RPC({ todos });
rpc.registerModel("Todo", Todo);
rpc.registerModel("Todos", Todos);

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
import { RPCClient, createReflectedModel } from "mixed-signals/client";
import type { Todo, Todos } from "./server.ts";

const TodoModel = createReflectedModel<Todo>(["text", "done"], ["toggle"]);
const TodosModel = createReflectedModel<Todos>(["all"], ["add"]);

const ws = new WebSocket("/rpc");
const rpc = new RPCClient({
  send: ws.send.bind(ws),
  onMessage: ws.addEventListener.bind(ws, "message"),
  ready: new Promise((r) => ws.addEventListener("open", r, { once: true })),
}, {});
rpc.registerModel("Todo", TodoModel);
rpc.registerModel("Todos", TodosModel);

function Demo({ ctx }) {
  const text = useSignal('');

  function add(e) {
    e.preventDefault();
    ctx.todos.add(text.value);
    text.value = '';
  }

  return <>
    <ul>
      <For each={todos.all}>
        {todo => (
          <li>
            <input type="checkbox" checked={todo.done} />
            {todo.text}
          </li>
        )}
      </For>
    </ul>
    <form onSubmit={add}>
      <input value={text} onInput={e => text.value = e.target.value} />
    </form>
  </>;
}

rpc.ready.then(() => {
  render(<Demo ctx={rpc.root} />, document.body);
});
```

## API

_Generated from TypeScript declarations._

### `mixed-signals/server`

#### `createMemoryTransportPair`

- Kind: **Function**
- Signatures:
  - `() => tuple` — Creates two linked Transport instances for in-process communication.
Messages sent on one end are delivered to the other via queueMicrotask.

#### `createModel`

- Kind: **Function**
- Signatures:
  - `(factory: ModelFactory<TModel, TFactoryArgs>) => ModelConstructor<TModel, TFactoryArgs>`

#### `RPC`

- Kind: **Class**
- Constructor:
  - `new RPC(root?: any) => RPC`
- Methods:
  - `addClient(transport: Transport, clientId?: string) => () => void`
  - `addUpstream(transport: Transport) => () => void` — Register an upstream mixed-signals connection whose models are forwarded
to downstream clients. All models from the upstream are automatically
forwarded — no per-model declaration needed.
  - `expose(root: any) => void`
  - `notify(method: string, params: any[], clientId?: string) => void`
  - `registerModel(name: string, Ctor: ModelConstructor) => void`

### `mixed-signals/client`

#### `asReflected`

- Kind: **Function**
- Signatures:
  - `(signal: ReadonlySignal<T>) => ReflectedSignal<T>` — Refine a signal to the reflected (server-owned) brand so it can be written
optimistically via optimistic. Signals produced by the reflection
layer carry the brand at runtime; this verifies it and narrows the static
type, throwing if the signal is a plain local one.

Use it when a reflected signal is typed more loosely than its runtime brand —
e.g. a generated transport interface that describes the signal as a plain
Signal/ReadonlySignal because the generator predates the
brand. This is a checked narrowing, not a blind cast: misuse fails fast
instead of producing an inert overlay.

#### `createReflectedModel`

- Kind: **Function**
- Signatures:
  - `(signalProps: typeOperator, methods: typeOperator) => ModelConstructor<ReflectedFacade<T>, tuple>`

#### `optimistic`

- Kind: **Function**
- Signatures:
  - `(action: Promise<unknown> | undefined, apply: (tx: OptimisticTransaction) => void) => OptimisticHandle` — Apply an optimistic change to the reflected signals the UI already renders,
bound to the promise of the action that will make it real. Nothing is
declared ahead of time: each change is layered over the live signal while
server deltas keep updating a hidden base, and the overlay reconciles to the
server-owned value once `action` settles.

Array changes require a primitive, unique `key`; each keyed
insert/remove/replace/move reconciles independently the moment the server
base reflects it. For keyed inserts the key must also appear on the eventual
server item (commonly an echoed client-mutation-id); otherwise a one-frame
duplicate may show until `action` settles and rolls the provisional item back.

For non-array values, reconciliation assumes the server pushes the reflecting
delta around the same time it replies (as the bundled `RPC` does). When the
reply does not coincide with the delta, pass `until` so the change reconciles
the moment the server reflects it. Without an `action`, reconcile manually
with OptimisticHandle.rollback.

#### `OptimisticHandle`

- Kind: **Interface**
- Controls a live optimistic transaction.
- Methods:
  - `rollback() => void` — Drop the optimistic changes and reconcile to the server-owned value.

#### `OptimisticTransaction`

- Kind: **Interface**
- Records optimistic changes against reflected signals within a transaction.
- Methods:
  - `set(args: SetArgs<T>) => void` — Replace a reflected signal's value optimistically. Array values require a
`key`; for keyed inserts the key must also appear on the eventual server
item, or a one-frame duplicate may show until the bound action settles.
  - `update(args: UpdateArgs<T>) => void` — Derive a reflected signal's next value from its current (read-only) one.
Array values require a `key`; for keyed inserts the key must also appear on
the eventual server item, or a one-frame duplicate may show until the bound
action settles.

#### `ReflectedSignal`

- Kind: **Interface**
- A reflected, server-owned signal that the UI renders read-only but may be
mutated optimistically through optimistic. The brand is nominal:
only signals produced by the reflection layer satisfy it, so passing a plain
local signal is a compile error. `T` is invariant (`in out`), so a
wider/narrower view cannot be substituted to smuggle a mistyped write into
the source.
- Methods:
  - `peek() => T`
  - `subscribe(fn: (value: T) => void) => () => void`
  - `toJSON() => T`
  - `toString() => string`
  - `valueOf() => T`
- Properties:
  - `[SOURCE]: Signal<T>`
  - `brand: query`
  - `value: T`

#### `RPCClient`

- Kind: **Class**
- Constructor:
  - `new RPCClient(transport: Transport, ctx?: any) => RPCClient<TRoot>`
- Methods:
  - `call(method: string, params?: any) => Promise<any>`
  - `expose(root: any) => void` — Publish an object as the dispatch target for peer-issued method
calls. Mirrors the server's `RPC.expose`: an inbound `M{id}:method`
frame is dispatched against this root using the same dot-notation
lookup the server uses for nested methods (e.g. `"browser.logs"`
walks `root.browser.logs`). Returning a non-promise sends `R{id}`
with the value; throwing or rejecting sends `E{id}` with the
`{code, message}` shape. Calling `expose` again replaces the prior
root.
  - `notify(method: string, params?: any[]) => void`
  - `onNotification(cb: (method: string, params: any[]) => void) => () => void`
  - `reconnect(transport: Transport) => void` — Replace the transport and reset internal state for a reconnection.
A new `ready` promise is created that resolves on the next `@R` message.
  - `registerModel(typeName: string, ctor: any) => void`
- Properties:
  - `ready: Promise<void>`
  - `root: TRoot`

### Shared

#### `Transport`

- Kind: **Interface**
- Methods:
  - `onMessage(cb: (data: { toString: unknown }) => void) => void`
  - `send(data: string) => void`
- Properties:
  - `ready?: Promise<void>`

