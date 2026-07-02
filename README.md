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

For optimistic inserts, the key must be present on the eventual server item as well, commonly via an app-level client mutation id echoed by the server. When the server echoes that key, pass `echoed: true`: the insert then reconciles strictly by key-confirmation and a successful action never rolls it back (only a rejection does), so an action that settles before the echo arrives no longer drops the provisional item for a frame. Leave it unset when the server assigns its own id, where the action's settlement is what cleans up the provisional row. Without an action, drive non-insert lifecycles yourself with the returned `handle.rollback()`.

### Confirming by mutation identity

When the bundled `RPC` handles a call, the deltas that call produces are echoed to the originating client tagged with the call's wire id, and `optimistic()` tags its patches with that same id. A change then confirms by mutation identity rather than by comparing values. A server-side normalization of the user's own edit (a trim, a clamp, a canonical form) still confirms and displays, while a concurrent write from another user does not confirm the pending change and is reported through `onConflict`. The optimistic value keeps shadowing until the change is confirmed or the action settles, so a concurrent write does not silently replace an unconfirmed edit on screen. Value comparison remains the fallback when no id is available, so a plain server keeps working.

Only the writes a method makes synchronously carry the call id. Writes a method makes after an internal `await` fall outside the tagging window and arrive untagged, so they reconcile by value or by the action settling. Until then such a write can momentarily read as a concurrent conflict. Keep the writes that back an optimistic change synchronous, or reconcile them with `until`.

Pass callbacks as a third argument to observe the lifecycle:

```ts
optimistic(session.rename(text), (tx) => tx.set({ signal: session.title, value: text }), {
  onSettle: () => toast("Saved"),
  onConflict: ({ server }) => toast(`Someone else set it to ${server}`),
  onError: (error) => report(error),
});
```

`handle.state` moves from `pending` to `settled`, `failed`, or `rolledback`. `onError` fires if applying a change to a concurrently moving server value throws, in which case that change is dropped and reported instead of wedging the signal.

On `reconnect()`, in-flight calls reject with `TransportClosedError` (the outcome is unknown, not failed, since the mutation may have committed on the previous connection) and optimistic overlays roll back to the last server value. Re-issue the mutation after `ready` if it must survive a reconnect.

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

When you hand-write the reflected model interface instead of importing the model types from the server, declare each signal as `Signal<T>` (or `ReadonlySignal<T>`), not `ReturnType<typeof signal<T>>`. `signal` is overloaded, so `ReturnType<typeof signal<T>>` widens to `Signal<T | undefined>` and every reflected value then reads as possibly `undefined`.

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

#### `ChangeOptions`

- Kind: **Type alias**
- Per-change options. Array changes require a primitive, unique `key` so inserts,
removes, replaces, and moves reconcile by element identity rather than by
position; for keyed inserts the key must also appear on the eventual server
item (commonly an echoed client-mutation-id). Non-array changes may pass
`until` for source-driven reconciliation. The two are mutually exclusive.
- Type: `conditional`

#### `createReflectedModel`

- Kind: **Function**
- Signatures:
  - `(signalProps: typeOperator, methods: typeOperator) => ModelConstructor<ReflectedFacade<T>, tuple>`

#### `Immutable`

- Kind: **Type alias**
- Deep read-only view of a value passed to an optimistic transform. Nested
reflected signals narrow to ReadonlySignal so the transform cannot
write the source, and functions are left intact.
- Type: `conditional`

#### `optimistic`

- Kind: **Function**
- Signatures:
  - `(action: Promise<unknown> | undefined, apply: (tx: OptimisticTransaction) => void, options?: OptimisticOptions) => OptimisticHandle` — Apply an optimistic change to the reflected signals the UI already renders,
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

#### `OptimisticConflict`

- Kind: **Interface**
- A divergent write reached a key or scalar this transaction is still holding
optimistically. The optimistic value keeps shadowing until the change is
confirmed; this only reports the divergence. Reported for list `replace` ops
and scalar values, never for object-valued transforms, whose owned fields are
unknown. Telling a genuine concurrent write apart from the server normalizing
this caller's own edit relies on the server echoing mutation ids: against a
server that does not echo them, the caller's own untagged confirming delta can
also surface here.
- Properties:
  - `key?: PropertyKey` — The key of the changed list item, or `undefined` for a scalar.
  - `optimistic: unknown` — The value this transaction optimistically wrote.
  - `server: unknown` — The concurrent value the server now holds.

#### `OptimisticHandle`

- Kind: **Interface**
- Controls a live optimistic transaction.
- Methods:
  - `rollback() => void` — Drop the optimistic changes and reconcile to the server-owned value.
- Properties:
  - `state: OptimisticState` — Current lifecycle state.

#### `OptimisticOptions`

- Kind: **Interface**
- Optional observability callbacks for an optimistic transaction.
- Properties:
  - `onConflict?: (conflict: OptimisticConflict) => void` — Runs when a divergent write reaches a key or scalar this transaction still
holds. Only fires for a change bound to an action whose wire id the server
echoes: reliable discrimination of a true concurrent write needs that echo,
and without it this can also fire for the caller's own normalized edit. A
change with no bound action never reports. May fire more than once.
  - `onError?: (error: unknown) => void` — Runs when applying a change to the (concurrently moving) server value
throws. The change is dropped and reported here rather than crashing the
delta pipeline. May fire more than once.
  - `onSettle?: () => void` — Runs once after a successful action reconciles to server truth.

#### `OptimisticState`

- Kind: **Type alias**
- Lifecycle of an optimistic transaction. A transport-closed rejection on
reconnect surfaces as `failed`.
- Type: `"pending" | "settled" | "failed" | "rolledback"`

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
  - `call(method: string, params?: any) => Promise<any>` — Issue a method call and resolve with its response. Not `async`: the exact
promise returned here is registered against the call's wire id, so passing
it straight to `optimistic()` binds the change to this mutation. Wrapping it
(`.then`, `Promise.all`) forfeits that binding and falls back to value-based
reconciliation.
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
  - `reconnect(transport: Transport) => void` — Replace the transport and reset internal state for a reconnection. A new
`ready` promise is created that resolves on the next `@R` message.

In-flight calls reject with TransportClosedError (outcome unknown,
not failed) and optimistic overlays roll back to the last server value,
since a fresh connection may land on a different node whose snapshot the
client has not yet seen. The bound optimistic change is therefore undone;
re-issue the mutation after `ready` if it must survive the reconnect.
  - `registerModel(typeName: string, ctor: any) => void`
- Properties:
  - `ready: Promise<void>`
  - `root: TRoot`

#### `SetArgs`

- Kind: **Type alias**
- Arguments for OptimisticTransaction.set.
- Type: `{ signal: ReflectedSignal<T>; value: T } & ChangeOptions<T>`

#### `TransportClosedError`

- Kind: **Class**
- Rejection reason for a call that was in flight when the transport was
replaced by RPCClient.reconnect. The outcome is *unknown*, not
failed: the mutation may already have committed on the previous connection.
Callers that need at-most-once semantics should retry idempotently (e.g.
keyed by a client mutation id) rather than treating it as a server error.
- Constructor:
  - `new TransportClosedError() => TransportClosedError`
- Properties:
  - `cause?: unknown`
  - `message: string`
  - `name: string`
  - `stack?: string`

#### `UpdateArgs`

- Kind: **Type alias**
- Arguments for OptimisticTransaction.update.
- Type: `{ signal: ReflectedSignal<T>; transform: (current: Immutable<T>) => T } & ChangeOptions<T>`

### Shared

#### `Transport`

- Kind: **Interface**
- Methods:
  - `onMessage(cb: (data: { toString: unknown }) => void) => void`
  - `send(data: string) => void`
- Properties:
  - `ready?: Promise<void>`

