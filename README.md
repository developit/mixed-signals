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

Reflected signals are server-owned: the client renders them as read-only computeds and the server overwrites them on the next push. So optimistic changes are layered _on top_ of the source rather than written into it. An overlay is a derived `ReadonlySignal` equal to the source folded through a stack of pending patches, and each patch is automatically dropped once the server reflects it. Rollback is just removing a patch, so there is no snapshot to restore and no dedup, realignment, or failure handling to write by hand.

Three builders cover the common shapes. Render the overlay's `value`, never the source.

```ts
import {optimisticList, optimisticObject, optimisticValue} from "mixed-signals/client";

// Lists: insert/remove/edit. The server must echo the client-generated key on
// the confirmed item, so reconciliation is deterministic.
const messages = optimisticList(conversation.messages, {
  key: (message) => message.clientId,
});
messages.insert(localMessage, conversation.send(localMessage.text, localMessage.clientId));

// Objects: set/delete a property (key-safe via `keyof`).
const profile = optimisticObject(user.profile);
profile.set("name", "Ada", user.rename("Ada"));

// Values: set a value.
const title = optimisticValue(doc.title);
title.set("Draft", doc.setTitle("Draft"));
```

Pass the action promise as the second argument: a rejection rolls the change back, and a resolution marks it confirmed. Reconciliation is driven by the source, not by the promise, so while the action is in flight the optimistic value stays on screen and the overlay only swaps to the server value once the confirming delta arrives, in a single update with no flicker. Without an action, drive the lifecycle yourself with `operation.confirm()` on success and `operation.rollback()` on failure.

Reconciliation is by exact match against the source: an object property settles when the source reflects the set value, a value when the source equals it, and a list item when the source contains a matching `key`. Matching is `Object.is` by default; pass `equals` (on `optimisticValue`/`optimisticObject`) when the server normalizes a write — e.g. trims a string — so the equal-but-not-identical value still reconciles. Confirmation never settles a change against a value that does not match, so a stale or unrelated delta cannot drop a newer optimistic write.

Within a shape, the latest change to a target supersedes earlier pending ones, so writing a value back to what the source holds cancels cleanly (no leftover overlay), and `optimisticList.remove` cancels a still-pending `insert`/`edit` of the same item rather than stacking beneath it.

Only lists require a matcher: a confirmed list item is a fresh server object with a new id, and a client-generated correlation key is the only robust way to recognize it (`match` is an escape hatch for servers that echo it under a different field). A list `insert` reconciles purely on that key — its action only rolls back on failure; resolving it does **not** settle the insert, so a server that never echoes the key (with no `match`) will leave the optimistic item beside the server copy.

For arbitrary changes (e.g. compaction that splices the list), drop to the core `createOptimistic(source).patch({apply, settled}, action?)`. The core treats each patch independently against the bare server value, so cancellation there is via `operation.rollback()`, not an opposing patch. Editing list items by non-primitive fields settles once the action confirms and the server moves those fields; for cached model facades, prefer a server version field. Object `delete` settles on the key's absence, but reflected objects use `merge` deltas that cannot remove a key — a deletion only reconciles when the server sends a full replacement (or the action confirms a delete of an optimistic-only key).

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

#### `createOptimistic`

- Kind: **Function**
- Signatures:
  - `(source: ReadonlySignal<T>) => Optimistic<T>` — Create an optimistic overlay over any reflected (read-only) signal.

#### `createReflectedModel`

- Kind: **Function**
- Signatures:
  - `(signalProps: string[], methods: string[]) => ModelConstructor<T, tuple>`

#### `Optimistic`

- Kind: **Interface**
- A derived, read-only overlay of a source signal plus pending patches.
- Methods:
  - `clear() => void` — Drop every pending patch.
  - `dispose() => void` — Drop every pending patch and stop observing the source.
  - `patch(patch: OptimisticPatch<T>, action?: Promise<unknown>) => OptimisticOperation` — Layer a patch over the source. While no patch is pending, a patch the source
already reflects is a no-op; once patches are live the new patch is always
layered (it may be needed to override them). A bound `action` confirms the
patch on resolve and rolls it back on reject.
- Properties:
  - `value: ReadonlySignal<T>` — Source value folded through every still-pending patch, in insertion order.

#### `OptimisticApply`

- Kind: **Type alias**
- Pure overlay transform applied over the current value. Must not mutate it.
- Type: `(current: T) => T`

#### `OptimisticKey`

- Kind: **Type alias**
- Stable application key used to reconcile optimistic items with server items.
- Type: `string | number`

#### `optimisticList`

- Kind: **Function**
- Signatures:
  - `(source: ReadonlySignal<readonly T[]>, options: OptimisticListOptions<T, K>) => OptimisticList<T>` — Create an optimistic overlay for a reflected list signal.

#### `OptimisticList`

- Kind: **Interface**
- Methods:
  - `clear() => void`
  - `dispose() => void`
  - `edit(item: T, changes: Partial<T>, action?: Promise<unknown>) => OptimisticOperation` — Override fields of a matching item; reconciled when the source reflects them.
  - `insert(item: T, action?: Promise<unknown>) => OptimisticOperation` — Append an item; reconciled only when the source contains a matching item
(by `key` or `match`). The bound action's resolution does not settle an
insert — if the server never echoes the key, supply `match` or the item
lingers alongside the server copy.
  - `remove(item: T, action?: Promise<unknown>) => OptimisticOperation` — Hide an item; reconciled when the source no longer contains it. Also cancels
any still-pending optimistic `insert`/`edit` for the same key.
- Properties:
  - `pending: ReadonlySignal<readonly T[]>` — Optimistic items present in the overlay but not yet in the source.
  - `value: ReadonlySignal<readonly T[]>` — Source list plus all currently unconfirmed optimistic items.

#### `OptimisticListOptions`

- Kind: **Interface**
- Methods:
  - `key(item: T) => K` — Return a stable key the server echoes on the confirmed item.
  - `match?(serverItem: T, optimisticItem: T) => boolean` — Match a server item that confirms an optimistic item under a different key.

#### `optimisticObject`

- Kind: **Function**
- Signatures:
  - `(source: ReadonlySignal<T>, options?: OptimisticObjectOptions<T>) => OptimisticObject<T>` — Create an optimistic overlay for a reflected object signal.

#### `OptimisticObject`

- Kind: **Interface**
- Methods:
  - `clear() => void`
  - `delete(key: K, action?: Promise<unknown>) => OptimisticOperation` — Delete a property; reconciled when the source drops the key.
  - `dispose() => void`
  - `set(key: K, value: T[K], action?: Promise<unknown>) => OptimisticOperation` — Set a property; reconciled when the source reflects the value.
- Properties:
  - `value: ReadonlySignal<T>` — Source object plus all currently unconfirmed optimistic property changes.

#### `OptimisticObjectOptions`

- Kind: **Interface**
- Methods:
  - `equals?(server: T[K], optimistic: T[K], key: K) => boolean` — Reconcile a property when the server value equals the optimistic value.
Defaults to `Object.is`. Use it when the server normalizes a write (e.g.
trimming) so the reflected value is equal-but-not-identical.

#### `OptimisticOperation`

- Kind: **Interface**
- Handle to a live optimistic patch.
- Methods:
  - `confirm() => void` — Mark the change as accepted so it reconciles once the source reflects it.
Called automatically when a bound action resolves. Idempotent.
  - `rollback() => void` — Drop this patch, typically after the action fails. Idempotent.

#### `OptimisticPatch`

- Kind: **Interface**
- A single optimistic change layered over a source value.
- Properties:
  - `apply: OptimisticApply<T>`
  - `settled: OptimisticSettled<T>`

#### `OptimisticSettled`

- Kind: **Type alias**
- True once the server-owned source has absorbed a patch, so it can be dropped.
`confirmed` is set when the bound action resolves (or `confirm()` is called).

Note: each patch is evaluated independently against the bare server value, so
a settled predicate cannot express "cancel an earlier patch". To return the
overlay to the source value, `rollback()` the earlier operation (the shape
builders below do this automatically when a later change targets the same key).
- Type: `(server: T, confirmed: boolean) => boolean`

#### `optimisticValue`

- Kind: **Function**
- Signatures:
  - `(source: ReadonlySignal<T>, options?: OptimisticValueOptions<T>) => OptimisticValue<T>` — Create an optimistic overlay for a reflected value signal.

#### `OptimisticValue`

- Kind: **Interface**
- Methods:
  - `clear() => void`
  - `dispose() => void`
  - `set(next: T, action?: Promise<unknown>) => OptimisticOperation` — Replace the value; reconciled when the source matches it.
- Properties:
  - `value: ReadonlySignal<T>` — Source value, or the pending optimistic value while one is set.

#### `OptimisticValueOptions`

- Kind: **Interface**
- Methods:
  - `equals?(server: T, optimistic: T) => boolean` — Reconcile when the server value matches the optimistic value. Defaults to `Object.is`.

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

