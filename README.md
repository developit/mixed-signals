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
- Delta compression for arrays (append), objects (merge), and strings (append) minimizes bandwidth

## Optimistic UI

Reflected signals are server-owned, but `optimistic()` lets you mutate the very signal the UI renders, at the call site, bound to the action that will make the change real. Nothing is declared ahead of time: the change is layered over the live signal, incoming server deltas keep updating a hidden base, and the overlay reconciles to the server-owned value once the action settles — or rolls back if it rejects.

```ts
import { optimistic } from "mixed-signals/client";

optimistic(session.send(text), (tx) => {
  tx.update(session.messages, (messages) => [...messages, localUserMessage]);
});
```

`tx.set` replaces a value and `tx.update` derives the next one from a read-only view of the current value. Both only accept reflected signals (`ReflectedSignal<T>`, produced by `createReflectedModel`), so passing a plain local signal is a compile error. Without an action, drive the lifecycle yourself with the returned `handle.rollback()`.

Reconciliation is driven by the server pushing the reflecting delta around the same time as the RPC reply (as the bundled `RPC` does), so the optimistic value stays on screen until the server-owned value takes over. Because there are no per-item keys, an `insert` may briefly show a duplicate if the append delta arrives before the reply.

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

Reconciliation assumes the server pushes the reflecting delta around the same
time it replies (as the bundled `RPC` does). If the reply arrives first, or
the signal is not being watched, the value briefly reverts to the server base
until the delta lands. Without an `action`, reconcile manually with
OptimisticHandle.rollback. Otherwise the patch is never dropped.

#### `OptimisticHandle`

- Kind: **Interface**
- Controls a live optimistic transaction.
- Methods:
  - `rollback() => void` — Drop the optimistic changes and reconcile to the server-owned value.

#### `OptimisticTransaction`

- Kind: **Interface**
- Records optimistic changes against reflected signals within a transaction.
- Methods:
  - `set(signal: ReflectedSignal<T>, value: T) => void` — Replace a reflected signal's value optimistically.
  - `update(signal: ReflectedSignal<T>, transform: (current: Immutable<T>) => T) => void` — Derive a reflected signal's next value from its current (read-only) one.
The transform must be pure: it may read `current` but must not mutate it.

#### `ReflectedSignal`

- Kind: **Interface**
- A reflected, server-owned signal that the UI renders read-only but may be
mutated optimistically through optimistic. The brand is nominal:
only signals produced by the reflection layer satisfy it, so passing a plain
local signal is a compile error. `T` is invariant, so a wider/narrower view
cannot be substituted to smuggle a mistyped write into the source.
- Methods:
  - `peek() => T`
  - `subscribe(fn: (value: T) => void) => () => void`
  - `toJSON() => T`
  - `toString() => string`
  - `valueOf() => T`
- Properties:
  - `[INVARIANT]: (value: T) => T`
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

