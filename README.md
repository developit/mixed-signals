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
wss.on("connection", (ws, request) => {
  // Feed a previously negotiated id back in here if your WebSocket URL
  // carries one. The server will report whether this process recognizes it.
  const connectionId =
    new URL(request.url, "http://localhost").searchParams.get("connectionId") ??
    undefined;
  rpc.addClient(
    {
      send: ws.send.bind(ws),
      onMessage: ws.on.bind(ws, "message"),
      onClose: (cb) => ws.on("close", cb),
    },
    connectionId,
  );
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
  onClose: (cb) => ws.addEventListener("close", () => cb(), { once: true }),
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

## Reconnects

`RPCClient.reconnect(newTransport)` swaps in a new transport while keeping the
existing root object, signals, and reflected model facades alive. The next `@R`
root snapshot refreshes existing signal values, rebinds root signals if the new
server process assigned different signal ids, refreshes cached model facades,
requests fresh snapshots for held model facades, and replays currently watched
signal subscriptions. Only explicit protocol identities are preserved: `@S`
signals and `@M` model facades. Unbranded nested arrays and plain objects are
replaced instead of reconciled by index or shape. Watches are replayed once
immediately from the ids already known in the root snapshot and again after
held-model refreshes bind any additional signal ids.

Servers include an opaque `connectionId` and `processId` with each root
snapshot. If the client reconnects with the same `connectionId`, the server's
`resumed` flag tells you whether this connection replaced active retained state
for that id. Same-process reconnects keep matching signal ids; different-process
reconnects still work when the new root snapshot contains the same logical model
ids. If a root snapshot omits connection metadata, the client treats it as an
unknown/new process once a root already exists, which keeps legacy servers safe
by avoiding raw signal-id reuse. Held model facades can also recover when the new
server process can resolve their `Type#id` markers from its instance registry.
For reconnectable transports (`onOpen` present), `client.ready` remains pending
if the transport disconnects before the first root snapshot and never opens
again. Callers that need a hard failure should wrap `ready` in their own timeout
or abort signal.

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
  - `(signalProps: string[], methods: string[]) => ModelConstructor<T, tuple>`

#### `RPCClient`

- Kind: **Class**
- Constructor:
  - `new RPCClient(transport: Transport, ctx?: any) => RPCClient`
- Methods:
  - `call(method: string, params?: any) => Promise<any>`
  - `expose(root: any) => void` — Publish an object as the dispatch target for peer-issued method
calls. Mirrors the server's `RPC.expose`: an inbound `M{id}:method`
frame is dispatched against this root using the same dot-notation
lookup the server uses for nested method calls (e.g. `"browser.logs"`
walks `root.browser.logs`). Returning a non-promise sends `R{id}`
with the value; throwing or rejecting sends `E{id}` with the
`{code, message}` shape. Calling `expose` again replaces the prior
root.
  - `notify(method: string, params?: any[]) => void`
  - `onNotification(cb: (method: string, params: any[]) => void) => () => void`
  - `reconnect(transport: Transport) => void` — Replace the transport for a reconnection. Cached roots, signals and model
facades are kept alive so the next `@R` snapshot can refresh/rebind them,
then currently watched signals are replayed on the new connection.
  - `registerModel(typeName: string, ctor: any) => void`
- Properties:
  - `connectionId: string | undefined` — Opaque server-assigned id that can be sent back on a future reconnect.
  - `connectionInfo: ConnectionInfo | undefined` — Metadata from the server process that sent the latest root snapshot.
  - `ready: Promise<void>`
  - `root: any`

### Shared

#### `ConnectionInfo`

- Kind: **Interface**
- Properties:
  - `connectionId: string` — Opaque id that can be supplied on a future server addClient() call.
  - `processId: string` — Opaque id for the server process that accepted this connection.
  - `resumed: boolean` — True when this connection replaced active state retained for connectionId.

#### `Transport`

- Kind: **Interface**
- Methods:
  - `onClose(cb: (error?: unknown) => void) => void`
  - `onMessage(cb: (data: { toString: unknown }) => void) => void`
  - `onOpen(cb: () => void) => void`
  - `send(data: string) => void`
- Properties:
  - `ready: Promise<void>`

