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
- **Client** models are proxy facades created automatically from the server-sent model definition; no client-side model registry is required
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
import { RPCClient } from "mixed-signals/client";
import type { Todos } from "./server.ts";

type Root = { todos: Todos };

const ws = new WebSocket("/rpc");
const rpc = new RPCClient<Root>({
  send: ws.send.bind(ws),
  onMessage: ws.addEventListener.bind(ws, "message"),
  onClose: (cb) => ws.addEventListener("close", () => cb(), { once: true }),
  ready: new Promise((r) => ws.addEventListener("open", r, { once: true })),
});

function Demo({ ctx }: { ctx: RPCClient<Root>["root"] }) {
  const text = useSignal('');

  function add(e) {
    e.preventDefault();
    ctx.todos.add(text.value);
    text.value = '';
  }

  return <>
    <ul>
      <For each={ctx.todos.all}>
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

If you do not want to pass the root type at each construction site, augment the client module once:

```ts
import type { Todos } from "./server.ts";

declare module "mixed-signals/client" {
  interface ReflectedRoot {
    todos: Todos;
  }
}

const rpc = new RPCClient(transport); // rpc.root is typed from ReflectedRoot
```

`createReflectedModel()` is still exported for older clients that prefer declared reflected facades, and `registerModel()` remains the custom-facade escape hatch. Ordinary reflected models need neither. Unknown model types are safe: the client builds a proxy from the received signal properties, and a missing method call rejects with the server's `Method not found` error.

## Reconnects

`RPCClient.reconnect(newTransport)` swaps in a new transport while keeping the
existing root object, signals, and reflected model facades alive. The next `@R`
root snapshot refreshes existing signal values, rebinds root signals if the new
server process assigned different signal ids, refreshes cached model facades,
requests fresh snapshots for active held model facades that were not present in
the reconnect root, and replays currently watched signal subscriptions. After a
process change, inactive held facades are marked stale; if one of their signal
props becomes watched later, the client lazily refreshes that facade before
replaying the new signal id. Only explicit protocol identities are preserved:
`@S` signals and `@M` model facades. Unbranded nested arrays and plain objects
are replaced instead of reconciled by index or shape. Watches are replayed once
immediately from the ids already known in the root snapshot and again after
held-model refreshes bind any additional signal ids.

Client reflection caches use weak references when the runtime supports them, so
cached signal ids and reflected model markers do not by themselves keep
unwatched, otherwise-unheld client objects alive. Watched signals remain strongly
tracked until their `@U` can be sent and so reconnect replay remains
deterministic.

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
  - `(signalProps?: readonly string[], methods: readonly string[]) => ModelConstructor<T, tuple>`

#### `Reflected`

- Kind: **Type alias**
- Client-side shape for a server value after mixed-signals reflection.
Signals become read-only client signals and methods become async RPC calls.
- Type: `conditional`

#### `ReflectedMethod`

- Kind: **Type alias**
- Type: `(args: Parameters<T>) => Promise<Reflected<Awaited<ReturnType<T>>>>`

#### `ReflectedModel`

- Kind: **Type alias**
- Client-side facade shape for a reflected server model instance.
- Type: `ReflectedObject<T> & { id: ReadonlySignal<string> }`

#### `ReflectedObject`

- Kind: **Type alias**
- Type: `mapped`

#### `ReflectedRoot`

- Kind: **Interface**
- Declaration-merging hook for projects that want a typed `RPCClient.root`
without passing a generic at every construction site.

#### `RPCClient`

- Kind: **Class**
- Constructor:
  - `new RPCClient(transport: Transport, ctx?: any, options?: RPCClientOptions) => RPCClient<TRoot>`
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
  - `registerModel(typeName: string, ctor?: (ctx: any, data: any) => any) => void` — Optionally register a custom facade constructor for a server model type.
Unregistered model types are reflected with proxy facades automatically.
- Properties:
  - `connectionId: string | undefined` — Opaque server-assigned id that can be sent back on a future reconnect.
  - `connectionInfo: ConnectionInfo | undefined` — Metadata from the server process that sent the latest root snapshot.
  - `ready: Promise<void>`
  - `root: Reflected<TRoot>`

#### `RPCClientOptions`

- Kind: **Interface**
- Properties:
  - `staleTimeout: number | false` — How long a call may wait with zero inbound traffic before the transport
is presumed dead. When the deadline passes, pending calls reject, the
normal disconnect lifecycle runs, and `transport.close()` is called if
the transport provides it.

This exists because a connection can go half-open: the network path is
gone (laptop slept, NAT entry expired, server died without a FIN) but no
close event fires, sometimes for minutes. Browsers don't expose
WebSocket ping/pong to JavaScript, so without a deadline a call issued
on such a socket waits forever.

Any inbound frame resets the clock, so a slow response on a connection
that is otherwise delivering traffic is not treated as staleness.
Defaults to 30 seconds. Set to `false` for transports that can't go
half-open, like a MessagePort to a worker, where blocking past the
deadline is legitimate.

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
  - `close() => void` — Close the underlying connection. The client calls this when it gives up
on a stale transport, so the dead connection doesn't linger.
  - `onClose(cb: (error?: unknown) => void) => void`
  - `onMessage(cb: (data: { toString: unknown }) => void) => void`
  - `onOpen(cb: () => void) => void`
  - `send(data: string) => void`
- Properties:
  - `ready: Promise<void>`

