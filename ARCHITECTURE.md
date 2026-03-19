# mixed-signals

Transparent projection of [Preact signals] over a transport. A server-side
`signal(x)` becomes a live client-side `Signal` that updates automatically.
No manual subscriptions, no event emitters — just signals.

[Preact signals]: https://github.com/preactjs/signals

---

## Concepts

| Concept                  | Description                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Transport**            | Any object with `send(data: string)` and `onMessage(cb)`. Typically a WebSocket.                                        |
| **RPC**                  | Server-side hub. Wraps a root object, routes incoming method calls, manages connected clients.                          |
| **Reflection**           | Server-side signal tracker. Serializes signal values, computes deltas, and pushes updates to subscribed clients.        |
| **Instances**            | Registry that maps numeric IDs to server-side model instances, enabling instance-method routing.                        |
| **RPCClient**            | Client-side hub. Sends method calls, awaits responses, and dispatches incoming notifications.                           |
| **ClientReflection**     | Client-side signal manager. Creates/updates `Signal` objects from server data, batches `@W`/`@U` subscription messages. |
| **createReflectedModel** | Factory that produces a Preact Model constructor whose signal props and methods mirror a server model.                   |

## Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  SERVER                                                          │
│                                                                  │
│  root object (ctx)                                               │
│    └─ ctx.projects.create(...)  ← RPC routes method calls here   │
│    └─ ctx.projects.all          ← Signal<Project[]>              │
│                                                                  │
│  RPC ──── Reflection ──── Instances                              │
│   │           │                                                  │
│   │    tracks Signals, serializes instances,                     │
│   │    computes deltas, pushes N:@S updates                      │
│   │                                                              │
│  Transport (WebSocket send/onMessage)                            │
└────────────────────────┬─────────────────────────────────────────┘
                         │  compact text protocol
┌────────────────────────┴─────────────────────────────────────────┐
│  CLIENT                                                          │
│                                                                  │
│  RPCClient ──── ClientReflection                                 │
│   │                  │                                           │
│   │           client Signal objects,                             │
│   │           batched watch/unwatch                              │
│   │                                                              │
│  createReflectedModel → Preact Model constructors                │
│    signals as computed props, methods as RPC proxies             │
└──────────────────────────────────────────────────────────────────┘
```

### Wire Protocol

All messages are compact, newline-free text strings.

#### Client → Server

| Message                 | Meaning                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `M{id}:{method}:{args}` | Method call (expects a response). `{id}` is a monotonic integer; `{args}` is comma-separated JSON values. |
| `N:{method}:{args}`     | Fire-and-forget notification. Same format but no response is sent.                                        |
| `N:@W:{ids}`            | Subscribe to signal updates. `{ids}` is comma-separated signal IDs.                                       |
| `N:@U:{ids}`            | Unsubscribe from signal updates.                                                                          |

#### Server → Client

| Message                      | Meaning                                                                    |
| ---------------------------- | -------------------------------------------------------------------------- |
| `R{id}:{result}`             | Successful response to call `{id}`. `{result}` is a single JSON value.     |
| `E{id}:{error}`              | Error response to call `{id}`. `{error}` is `{"code":-1,"message":"..."}`. |
| `N:@S:{id},{value}[,{mode}]` | Signal update notification. `{mode}` is omitted for full replacement.      |

#### Method Routing

- **Direct RPC calls** — `path.method` (e.g. `sessions.createSession`) for methods on the root object
- **Reflected model methods** — `{wireId}#method` (e.g. `42#delete`) for methods on model instances
- The server assigns `wireId`s when it serializes models with `@M`, and `createReflectedModel()` uses that identity for later calls.

#### Serialization Markers

During serialization, special objects are embedded in JSON:

| Marker | Shape                                 | Meaning                                                                                                                                   |
| ------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@S`   | `{"@S": id, "v": value}`              | A server-side `Signal`. The client creates or reuses a `Signal` with the given ID and initial value.                                      |
| `@M`   | `{"@M": "TypeName#wireId", ...props}` | A server-side model instance. The client instantiates the registered model constructor for `TypeName` and uses `wireId` for method calls. |

Properties beginning with `_` and all functions are stripped from serialized objects.

#### Delta Update Modes

When a signal's value changes, the server may send only the diff instead of the full value:

| Mode     | Applies when                                               | Effect on client                                                     |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| _(none)_ | General case                                               | Full replacement: `sig.value = newValue`                             |
| `append` | Array grew by appending, or string got longer by appending | `sig.value = [...current, ...delta]` / `sig.value = current + delta` |
| `merge`  | Plain object with changed keys                             | `sig.value = {...current, ...delta}`                                 |
| `splice` | Array mutation with start/deleteCount/items                | `Array.prototype.splice` applied immutably                           |

---

## Shape

```
mixed-signals/
├── server/
│   ├── rpc.ts          multi-client RPC host, method routing
│   ├── reflection.ts   Signal → wire, subscriptions, delta diffing
│   └── instances.ts    id ↔ model instance registry
└── client/
    ├── rpc.ts          RPC client, request correlation
    ├── reflection.ts   wire → Signal, batched watch/unwatch
    └── model.ts        Preact-model factory for remote facades
```

Two bundles (`./server`, `./client`) with a single peer dep:
`@preact/signals-core >= 1.8.0` (needs `watched`/`unwatched` hooks).

---

## The core trick

A `Signal` crosses the wire as `{"@S": <id>, "v": <snapshot>}`. The client
rehydrates it into a real `signal()`, wiring its `watched`/`unwatched` hooks
to `@W`/`@U` notifications. The server only subscribes to the underlying
signal while ≥1 client is watching, and pushes diffs via `N:@S:`.

**Reactivity is the subscription protocol.** If no component reads
`user.name.value`, the server never sends updates for it.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ SERVER                                                                     │
│                                                                            │
│   const count = signal(0)                                                  │
│        │                                                                   │
│        │  serialize()                ┌──────────────────────────────┐      │
│        └──────────────────────────▶  │ Reflection                   │      │
│                                      │  signalIds:  WeakMap<Sig,id> │      │
│           assigns id=7               │  signals:    Map<id,Sig>     │      │
│           {"@S":7,"v":0}  ──────┐    │  subs:       Map<id,Set<c>>  │      │
│                                 │    │  lastSent:   Map<"c:id",val> │      │
│                                 │    └───────────────▲──────────────┘      │
│                                 │                    │                     │
│                                 │     @W:7 ──────────┘  sig.subscribe()    │
│                                 │     (first watcher)   → notifySubscribers│
└─────────────────────────────────┼──────────────────────────────────────────┘
                                  │ ▲                  │
                         R1:{...} │ │ N:@W:7           │ N:@S:7,1
                                  ▼ │                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ CLIENT                                                                      │
│                                 ┌──────────────────────────────┐            │
│   JSON.parse(reviver) ────────▶ │ ClientReflection             │            │
│    sees "@S" → calls            │  signals: Map<id,Signal>     │            │
│    getOrCreateSignal(7,0)       │  watchBatch / unwatchBatch   │ ── 1ms ──▶ │
│                                 └────────────┬─────────────────┘    flush   │
│                                              │                              │
│           ┌──────────────────────────────────┘                              │
│           ▼                                                                 │
│   signal(0, {                                                               │
│     watched:   () => scheduleWatch(7),    ◀── effect(() => s.value)         │
│     unwatched: () => scheduleUnwatch(7)       first subscriber triggers     │
│   })                                                                        │
│                                                                             │
│   handleUpdate(7, 1)  →  s.value = 1  →  effect re-runs                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Wire protocol

Plaintext, regex-parseable, one message per frame.

```
  ┌─ type char                ┌─ JSON fragments, comma-joined (no outer [])
  │  ┌─ correlation id        │
  ▼  ▼                        ▼
  M  17  :  threads.create  :  "hello",{"role":"user"}
  │      │                  │
  │      └─ method / topic ─┘
  │
  ├─ M<id>:<method>:<args>   client → server   call         (expects R/E)
  ├─ N    :<method>:<args>   either direction  notify       (fire-and-forget)
  ├─ R<id>:<json>            server → client   resolve(id)
  └─ E<id>:<json>            server → client   reject(id)
```

Reserved methods:

| method | dir | payload           | meaning                       |
| :----: | :-: | ----------------- | ----------------------------- |
|  `@W`  | c→s | `id,id,...`       | subscribe to these signal ids |
|  `@U`  | c→s | `id,id,...`       | unsubscribe                   |
|  `@S`  | s→c | `id,value[,mode]` | signal `id` changed           |

Routing on server (`callMethod`):

```
  "threads.create"   →  dlv(root, "threads.create")(...args)
  "42#rename"        →  instances.get(42).rename(...args)
      └─ id#method
```

---

## Serialization

`Reflection.serialize()` is a `JSON.stringify` replacer that rewrites
live objects into wire markers. The client's `JSON.parse` reviver inverts it.

```
  server value                     wire                          client value
 ──────────────                ────────────                    ───────────────
  signal(3)           ──▶   {"@S":7,"v":3}          ──▶   live Signal (id 7)

  thread instance     ──▶   {"@M":"Thread#42",      ──▶   new ThreadModel(ctx,
  (registered in             "id":{"@S":9,"v":42},          data)  via
   Instances with            "title":{"@S":10,...}}         modelRegistry
   type "Thread")

  obj._private        ──▶   (dropped)
  obj.method          ──▶   (dropped — replaced by RPC stubs on client)
```

`@M` handling is eager: it iterates own props, inlines nested `@S` markers
immediately (so `Signal.toJSON()` never runs), and strips `_`-prefixed and
function props.

---

## Delta compression

Server holds `lastSentValues["<client>:<signal>"]`. On change it computes the
smallest patch that reconstructs `newValue` from `oldValue`:

```
                                      ┌─────────┐
  old            new           mode   │ client  │
  ───            ───           ────   │ applies │
  [a,b]       →  [a,b,c,d]     append │ [...cur, ...Δ]
  "foo"       →  "foobar"      append │ cur + Δ
  {x:1,y:2}   →  {x:1,y:9}     merge  │ {...cur, ...Δ}    (sends {y:9} only)
  anything    →  unrelated     —      │ Δ                 (full replace)
                                      └─────────┘
```

Array-append is detected by prefix identity (`===` per element), so it only
fires when the _same_ elements are reused — i.e. immutable push patterns like
`sig.value = [...sig.value, item]`.

The client also handles `splice` mode; the server doesn't currently emit it.

---

## Subscription lifecycle

```
 client                                              server
 ──────                                              ──────
 component mounts
   effect reads s.value
     └─▶ watched()
           watchBatch.add(7)  ─── 1ms ──▶  N:@W:7,8,12  ─▶  subs.get(7).add(client)
                                                            if first watcher:
                                                              sig.subscribe(notify)
 component unmounts
   effect disposed
     └─▶ unwatched()
           setTimeout(10ms)                             ← debounce: if a remount
             └─▶ unwatchBatch.add(7) ─ 1ms ─▶ N:@U:7      happens inside 10ms the
                                                          unwatch is cancelled and
                                                          no traffic is sent.
 client disconnects
   cleanup()  ───────────────────────────────────────▶  clients.delete(id)
                                                        reflection.removeClient(id)
                                                          - drop from all subs sets
                                                          - purge lastSentValues
```

Batching coalesces the "20 signals arrive in one response, 20 effects
subscribe on the same tick" case into one `@W` frame.

---

## `createReflectedModel`

Generates a Preact `createModel` constructor that mirrors a server model.

```
                      signalProps      methods
                      ───────────      ───────
                      ['id','title']   ['rename']
```

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  createReflectedModel(signalProps, methods)                                 │
│                                                                             │
│  ┌──────────────── per signalProp ─────────────────┐                        │
│  │                                                 │   The @M reviver       │
│  │  data[p] is Signal?                             │   already created the  │
│  │  ── yes ─▶  computed(() => data[p].value)       │   inner signals.       │
│  └─────────────────────────────────────────────────┘                        │
│                                                                             │
│  ┌──────────────── per method ─────────────────────┐                        │
│  │                                                 │                        │
│  │  ctx.rpc.call(`${wireId}#${m}`, args)            │   instance route       │
│  └─────────────────────────────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

UI binds to `model.title.value`, which tracks the computed wrapping the
remote signal. Swapping the underlying facade (e.g. after a refetch)
propagates without the UI knowing.

---

## Data flow (one round-trip)

```
 UI                RPCClient         wire           RPC              domain
 ──                ─────────         ────           ───              ──────
 todo.toggle()
   │
   └─▶ call("42#toggle", [])
         pending.set(1,{res,rej})
         │
         └────────────────────────▶ M1:42#toggle:
                                       │
                                       └─▶ instances.get("42").toggle()
                                              │
                                              ▼
                                           todo.done.value = true
                                              │
                                    notifySubscribers(11)
                                     computeDelta → full replace
                                              │
         ◀──────────────────────── N:@S:11,true
         │
   handleUpdate(11, true)
    sig.value = true
   │
 <Todo> re-renders
```

---

## Invariants

- **Signal identity** — one server `Signal` = one wire id for the process
  lifetime (`WeakMap<Signal,id>`). Re-serializing the same signal yields the
  same id; the client dedupes on it.
- **Instance identity** — `Instances.nextId()` skips occupied slots and
  ratchets past any `register(id, …)` so storage-hydrated ids and fresh ids
  never collide.
- **At-most-once push** — `lastSentValues` gates notifications by `===`.
  Redundant `sig.value = same` writes never touch the wire.
- **Lazy fan-out** — a server signal with zero watchers has zero
  `.subscribe()` callbacks attached to it.
- **Transport-agnostic** — `Transport = { send(str), onMessage(cb), ready? }`.
  WebSocket, MessagePort, stdin/stdout all fit.
