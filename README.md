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

Reflected signals are server-owned, so client optimism should be layered on top instead of mutating the reflected signal. `createOptimisticList()` creates a computed overlay for list signals and removes optimistic items once the server reflects an item with the same application key.

```ts
import { createOptimisticList } from "mixed-signals/client";

const messages = createOptimisticList(session.messages, {
  key: (message) => message.clientId.value,
});

const operation = messages.insert(localUserMessage);

try {
  await session.send(localUserMessage.text.value, localUserMessage.clientId.value);
} catch {
  operation.rollback();
}
```

Render `messages.value` instead of the reflected `session.messages` signal. The server should echo the client-generated key on the confirmed item so reconciliation is deterministic.

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

#### `createOptimisticList`

- Kind: **Function**
- Signatures:
  - `(source: ReadonlySignal<readonly T[]>, options: OptimisticListOptions<T, TKey>) => OptimisticList<T, TKey>` — Create a client-side optimistic overlay for a reflected list signal.
The source signal is never mutated; server-confirmed items are reconciled by key.
While optimistic items are pending, the source is subscribed so confirmations
can be pruned even if the overlay is not currently observed.

#### `createReflectedModel`

- Kind: **Function**
- Signatures:
  - `(signalProps: string[], methods: string[]) => ModelConstructor<T, tuple>`

#### `OptimisticList`

- Kind: **Interface**
- Methods:
  - `clear() => void` — Remove all pending optimistic operations.
  - `dispose() => void` — Stop reconciliation effects and remove all pending optimistic operations.
  - `insert(item: T) => OptimisticListOperation<T, TKey>` — Add an optimistic item without mutating the reflected source signal.
  - `remove(operation: OptimisticListOperation<T, TKey>) => void` — Remove a previously inserted optimistic operation.
- Properties:
  - `pending: ReadonlySignal<readonly T[]>` — Optimistic items that have not been confirmed by the server source.
  - `value: ReadonlySignal<readonly T[]>` — Server source list plus all currently unconfirmed optimistic items.

#### `OptimisticListKey`

- Kind: **Type alias**
- Type: `string | number`

#### `OptimisticListOperation`

- Kind: **Interface**
- Methods:
  - `rollback() => void` — Remove this optimistic item, typically after the server rejects a call.
- Properties:
  - `id: number`
  - `item: T`
  - `key: TKey`

#### `OptimisticListOptions`

- Kind: **Interface**
- Methods:
  - `key(item: T) => TKey` — Return a stable application key used to reconcile optimistic items.
  - `match?(serverItem: T, optimisticItem: T) => boolean` — Optionally match server-confirmed items that use a different key.

#### `RPCClient`

- Kind: **Class**
- Constructor:
  - `new RPCClient(transport: Transport, ctx?: any) => RPCClient`
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
  - `root: any`

### Shared

#### `Transport`

- Kind: **Interface**
- Methods:
  - `onMessage(cb: (data: { toString: unknown }) => void) => void`
  - `send(data: string) => void`
- Properties:
  - `ready?: Promise<void>`
