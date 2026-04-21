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

## Transports

A `Transport` is anything that moves framed wire messages between peers.
Two flavors:

- **`StringTransport`** (default) — the library stringifies every message
  to `M1:method:payload` framing and hands you a string to `.send()`. Use
  for byte-stream wires: WebSocket, stdio, fetch/SSE, React Native's
  `WebView.postMessage`.
- **`RawTransport`** (opt in with `mode: 'raw'`) — the library skips the
  stringify and hands you the `WireMessage` object directly. Use for
  structured-clone wires: `Worker.postMessage`, `MessagePort`,
  `BroadcastChannel`. Skipping JSON saves a walk and lets `postMessage`
  transfer `ArrayBuffer` / `MessagePort` etc. by ownership.

Both share the same `encode` / `decode` per-node hooks (see below). The
only thing that differs is whether stringification happens.

```ts
// String transport (WebSocket): library serializes, you move bytes
const wsTransport: StringTransport = {
  send: (str) => ws.send(str),
  onMessage: (cb) => ws.addEventListener('message', e =>
    cb({toString: () => e.data})),
};

// Raw transport (Worker): library hands you the object, you move it
const workerTransport: RawTransport = {
  mode: 'raw',
  send: (msg, ctx) => worker.postMessage(msg, ctx),
  onMessage: (cb) => worker.addEventListener('message', e => cb(e.data)),
};
```

### `ctx.transfer` for `postMessage` ownership transfer

The second argument to `send` is a `TransportContext` whose base shape
(`{transfer?: Transferable[]}`) is the exact options object
`Worker.postMessage(msg, options)` expects. The serializer populates
`ctx.transfer` for every `ArrayBuffer` / `MessagePort` / `ImageBitmap` /
stream it walks past, so a `RawTransport` can hand it straight to
`postMessage` and values get transferred rather than copied. No bespoke
plumbing — the DOM reads `transfer` and ignores extra keys, so you can
also attach your own metadata to `ctx` for middleware / auth / logging.

## Rich types via codecs

Out of the box the wire handles everything JSON handles, plus `@H`-marked
handles (signals, models, functions, promises). For richer JS types —
`Map`, `Set`, typed arrays, `Date`, `RegExp`, `Error`, `URL`, `BigInt` —
add the codec pair from `mixed-signals/codecs` to your transport:

```ts
import {encode, decode} from 'mixed-signals/codecs';

const transport: StringTransport = {
  encode, decode,               // ← object-shorthand slot-in
  send: (str) => webview.postMessage(str),
  onMessage: (cb) => webview.addEventListener('message', e =>
    cb({toString: () => e.data})),
};
```

`encode` runs top-down during outbound serialization and tags each rich
value as `{@T: 'tag', d: body}`. `decode` runs bottom-up during inbound
hydration and rebuilds them. Both follow an `undefined`-means-pass-through
convention so they compose with user codecs via `??`:

```ts
class Money { constructor(public amount: number, public currency: string) {} }

const encodeMoney = (v: unknown) =>
  v instanceof Money ? {'@T': 'money', d: [v.amount, v.currency]} : undefined;
const decodeMoney = (v: any) =>
  v?.['@T'] === 'money' ? new Money(v.d[0], v.d[1]) : undefined;

const transport: StringTransport = {
  encode: (v) => encodeMoney(v) ?? encode(v),
  decode: (v) => decodeMoney(v) ?? decode(v),
  send, onMessage,
};
```

`@H` (handle) and `@T` (codec tag) compose cleanly: a `Map` containing a
Signal round-trips as a real `Map<K, Signal<V>>` with live subscriptions
preserved. Nested rich types work the same way — the walker recurses into
tagged bodies.

On raw transports, structured clone handles most built-ins natively, so
codec registration is optional. Register only when you have types
structured clone doesn't know (custom classes) or want explicit control.

## API

_Generated from TypeScript declarations._

### `mixed-signals/server`

#### `createMemoryTransportPair`

- Kind: **Function**
- Signatures:
  - `() => tuple` — Creates two linked `StringTransport` instances for in-process communication.
Messages sent on one end are delivered to the other via `queueMicrotask`.

#### `createModel`

- Kind: **Function**
- Signatures:
  - `(name: string, factory: ModelFactory<TModel, TFactoryArgs>) => ModelConstructor<TModel, TFactoryArgs>` — Create a server-side Model with a stable wire name. The name crosses the
wire once per client and is used on the receiving side to expose the
type (e.g. for `instanceof`-like checks and logging).

The name is stamped onto the resulting constructor via a registered symbol,
which lets the serializer identify "named objects" (Models) vs anonymous
plain objects without a central registry on either side.

#### `createRawMemoryTransportPair`

- Kind: **Function**
- Signatures:
  - `() => tuple` — Creates two linked `RawTransport` instances for in-process communication.
Messages are structurally cloned via `structuredClone()` before delivery,
matching the semantics a real `postMessage` boundary would have — so tests
catch values that fail to survive structured clone (functions, Proxies
without a backing target, etc.).

`ctx` is also cloned (minus `transfer`, which would otherwise trigger
transfer-list validation that the Node polyfill may not implement
identically to the browser). Transferables themselves are delivered as-is
so `instanceof ArrayBuffer` identity is preserved on the receiving end.

#### `RetentionPolicy`

- Kind: **Type alias**
- Type: `{ kind: "disconnect" } | { idleMs: number; kind: "ttl"; sweepMs?: number } | { kind: "weak" }`

#### `RPC`

- Kind: **Class**
- Server-side RPC hub. Owns:
  - A shared `Handles` registry (ids for signals, models, plain objects,
    functions, promises).
  - A `Reflection` instance that manages signal subscriptions and delta
    pushes for every connected client.
  - One `PeerCodec` per connected client — a thin wrapper around the
    user-provided `Transport` that speaks a mode-agnostic `WireMessage`
    interface internally. Clients can mix string- and raw-mode transports
    on the same server.

There is no `registerModel`. Use `createModel(name, factory)` — the name is
stamped on the ctor and the serializer picks it up automatically.
- Constructor:
  - `new RPC(root?: any, options: RPCOptions) => RPC`
- Methods:
  - `addClient(transport: Transport, clientId?: string) => () => void`
  - `addUpstream(transport: Transport) => () => void` — Register an upstream mixed-signals connection whose handles are
transparently forwarded to downstream clients. All handles are
auto-forwarded — no per-type declaration needed.

Upstreams are string-mode only today. A raw upstream would need the
prefix/strip walkers in `forwarding.ts` to traverse structured trees,
which they already do — but the framing layer ties them to strings.
  - `close() => void` — Shut the RPC down: disconnect all clients, dispose upstreams, cancel any
pending timers. After `close()` the instance must not be reused.
  - `expose(root: any) => void`
  - `notify(method: string, params: any[], clientId?: string) => void`
  - `removeClient(clientId: string) => void`

#### `RPCOptions`

- Kind: **Interface**
- Properties:
  - `retention: RetentionPolicy` — When the server should auto-release handles with no client refs.
Default is `{kind: 'ttl', idleMs: 30_000}` — reclaimed 30s after the last
release. `disconnect` releases on client disconnect only. `weak` uses
WeakRefs at the registry level.

### `mixed-signals/client`

#### `createReflectedModel`

- Kind: **Function**
- Signatures:
  - `(_signalProps?: typeOperator, _methods?: typeOperator) => (data: U) => U`

#### `RPCClient`

- Kind: **Class**
- Client-side RPC hub.

No model registration is required. Every incoming value is hydrated
automatically — Models and plain objects become `Proxy`s, functions become
callable proxies, promises become live `Promise`s, signals become real
`Signal`s wired to the watch/unwatch protocol.

Works with either a `StringTransport` (the default — WebSocket, stdio,
etc.) or a `RawTransport` (postMessage / MessagePort / Worker). On the
raw path, outbound calls walk the arg tree to substitute branded remote
handles with `@H` markers and collect Transferable values into
`ctx.transfer`, which the transport hands to `postMessage(msg, ctx)`.
- Constructor:
  - `new RPCClient(transport: Transport, _ctx?: any) => RPCClient`
- Methods:
  - `call(method: string, params?: any) => Promise<any>`
  - `classOf(name: string) => () => any | undefined` — Resolve the constructor for a remote class by name. Every class instance
the client has hydrated is built on a shared prototype, so you can use
the returned function with `instanceof`:

  const Counter = client.classOf('Counter');
  value instanceof Counter;

Returns `undefined` if no instance of a class with that name has been
received yet.
  - `notify(method: string, params?: any[]) => void`
  - `onNotification(cb: (method: string, params: any[]) => void) => () => void`
  - `reconnect(transport: Transport) => void`
- Properties:
  - `ready: Promise<void>`
  - `root: any`

### `mixed-signals/codecs`

#### `decode`

- Kind: **Function**
- Signatures:
  - `(v: unknown) => unknown` — Per-node inbound transform. Resolves `@T`-tagged objects produced by
`encode` (or any compatible codec) back to their native types. Returns
`undefined` when the node doesn't carry a recognized tag.

#### `encode`

- Kind: **Function**
- Signatures:
  - `(v: unknown) => unknown` — Per-node outbound transform. Returns a `@T`-tagged object for any rich
type this bundle knows about; otherwise `undefined` (pass through).

### Shared

#### `RawTransport`

- Kind: **Interface**
- Wire "framing" is a structured object the transport delivers as-is. Use
for `postMessage`-family transports (Worker, MessagePort, DedicatedWorker,
BroadcastChannel-likes). Skips JSON stringify/parse entirely; the
serializer populates `ctx.transfer` so ArrayBuffer / MessagePort / etc.
can be transferred rather than copied.
- Methods:
  - `decode(value: unknown, ctx?: Ctx) => unknown` — Optional per-node inbound transform. Invoked by the library's hydrator
at every value during deserialization (bottom-up). Return a replacement
to rebuild a rich type from its `@T` tag; return `undefined` to pass
through. By the time `decode` sees `{@T: 'map', d: [...]}`, the `d`
children have already been decoded — so `new Map(decodedEntries)` works
directly and nested live Signals land where they should.
  - `encode(value: unknown, ctx?: Ctx) => unknown` — Optional per-node outbound transform. Invoked by the library's walker at
every value during serialization (top-down). Return a replacement
(typically `{@T: 'tag', d: ...}`) to tag a rich type; return `undefined`
(or the value unchanged) to pass through. The walker recurses into the
replacement, so nested handles / signals inside a tagged body still get
emitted as `@H` correctly.

This is where Map / Set / TypedArray / custom class tagging lives — see
`mixed-signals/codecs` for a ready-made set or compose per-type helpers
with `??` chaining.
  - `onMessage(cb: (data: unknown, ctx?: Ctx) => void | Promise<void>) => void`
  - `send(data: unknown, ctx?: Ctx) => void`
- Properties:
  - `mode: "raw"`
  - `ready: Promise<void>`

#### `StringTransport`

- Kind: **Interface**
- Wire framing is the compact string protocol (`M1:method:payload`, etc.).
Every payload passes through `JSON.stringify` / `JSON.parse`. Use for
byte-stream transports (WebSocket, stdio, fetch/SSE).
- Methods:
  - `decode(value: unknown, ctx?: Ctx) => unknown` — Optional per-node inbound transform. Invoked by the library's hydrator
at every value during deserialization (bottom-up). Return a replacement
to rebuild a rich type from its `@T` tag; return `undefined` to pass
through. By the time `decode` sees `{@T: 'map', d: [...]}`, the `d`
children have already been decoded — so `new Map(decodedEntries)` works
directly and nested live Signals land where they should.
  - `encode(value: unknown, ctx?: Ctx) => unknown` — Optional per-node outbound transform. Invoked by the library's walker at
every value during serialization (top-down). Return a replacement
(typically `{@T: 'tag', d: ...}`) to tag a rich type; return `undefined`
(or the value unchanged) to pass through. The walker recurses into the
replacement, so nested handles / signals inside a tagged body still get
emitted as `@H` correctly.

This is where Map / Set / TypedArray / custom class tagging lives — see
`mixed-signals/codecs` for a ready-made set or compose per-type helpers
with `??` chaining.
  - `onMessage(cb: (data: { toString: unknown }, ctx?: Ctx) => void | Promise<void>) => void`
  - `send(data: string, ctx?: Ctx) => void`
- Properties:
  - `mode: "string"`
  - `ready: Promise<void>`

#### `Transport`

- Kind: **Type alias**
- Type: `StringTransport<Ctx> | RawTransport<Ctx>`

#### `TransportContext`

- Kind: **Interface**
- Context object carried alongside every wire message. Defaults to the
postMessage options shape so a RawTransport can pass it through directly:

  Worker.prototype.postMessage(message, options?)   // options = {transfer?}
  MessagePort.prototype.postMessage(message, options?)
  DedicatedWorkerGlobalScope.prototype.postMessage(message, options?)

Extra keys on `ctx` are ignored by the DOM per spec. Consumers may extend
the interface with their own metadata (auth, correlation ids, etc.) and a
well-behaved transport will propagate it end to end.
- Properties:
  - `transfer: Transferable[]`

#### `typeOfRemote`

- Kind: **Function**
- Signatures:
  - `(value: unknown) => string | undefined` — Introspection helper: returns the class/model name of a remote proxy.

