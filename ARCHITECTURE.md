# mixed-signals

Transparent projection of [Preact signals] over a transport. A server-side
`signal(x)` becomes a live client-side `Signal` that updates automatically.
No manual subscriptions, no event emitters — just signals.

[Preact signals]: https://github.com/preactjs/signals

---

## Concepts

| Concept                  | Description                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Transport**            | Any object with `send(data: string)` and `onMessage(cb)`, plus optional `onOpen(cb)`, `onClose(cb)`, and `ready`. Typically a WebSocket. |
| **RPC**                  | Server-side hub. Wraps a root object, routes incoming method calls, manages connected clients.                          |
| **Reflection**           | Server-side signal tracker. Serializes signal values, computes deltas, and pushes updates to subscribed clients.        |
| **Instances**            | Registry that maps numeric IDs to server-side model instances, enabling instance-method routing.                        |
| **RPCClient**            | Client-side hub. Sends method calls, awaits responses, and dispatches incoming notifications.                           |
| **ClientReflection**     | Client-side signal manager. Creates/updates `Signal` objects from server data, batches `@W`/`@U` subscription messages. |
| **Proxy facade**         | Client-side reflected model object built from `@M` data. Serialized signal props become computed signals; unknown string props become lazy RPC methods. |

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
│  @M reviver → Proxy facades                                      │
│    discovered signals as computed props, methods as lazy RPC     │
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
| `N:@D:{ids}`            | Forget collected model markers or signal IDs; the next send must inline their full representation.       |

#### Server → Client

| Message                      | Meaning                                                                    |
| ---------------------------- | -------------------------------------------------------------------------- |
| `R{id}:{result}`             | Successful response to call `{id}`. `{result}` is a single JSON value.     |
| `E{id}:{error}`              | Error response to call `{id}`. `{error}` is `{"code":-1,"message":"..."}`. |
| `N:@S:{id},{value}[,{mode}]` | Signal update or seal notification. `{mode}` is omitted for full replacement. |
| `N:@D:"Type#id"`           | A registered model instance was removed (or a requested marker is no longer available). |

#### Method Routing

- **Direct RPC calls** — `path.method` (e.g. `sessions.createSession`) for methods on the root object
- **Reflected model methods** — `{wireId}#method` (e.g. `42#delete`) for methods on model instances
- The server assigns `wireId`s when it serializes models with `@M`, and the client proxy uses that identity for later calls.

#### Serialization Markers

During serialization, special objects are embedded in JSON:

| Marker | Shape                                 | Meaning                                                                                                                                   |
| ------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@S`   | `{"@S": id, "v": value}`              | A server-side `Signal`. The client creates or reuses a `Signal` with the given ID and initial value.                                      |
| `@S`   | `{"@S": id}`                          | The same signal, without its value: the client already holds it (identical last-sent value plus a live subscription), so the ref resolves against the signal it has. Returning a reflected signal from a method is therefore cheap — the value travels once, as a signal update. |
| `@S`   | `{"@S": id, "v": value, "f": 1}`      | A final signal: the server promises it will never change. The client still gets a `Signal`, but observing it sends no `@W`, and the server opens no subscription for it. |
| `@M`   | `{"@M": "TypeName#wireId", ...props}` | A server-side model instance. The client reuses a cached facade or creates a proxy facade directly from the serialized props. Custom registered constructors are still supported. |

Model-owned signal properties omit `@S`: `{"@M":"Chat#13","title":{"v":"Hello"}}`
identifies the signal as `Chat#13.title`. If an ordinary model property has a
`v` key, the model includes `"@P":["propertyName"]` to distinguish it from a
signal snapshot. Top-level and other standalone signals still use `@S`.
Neither form implicitly subscribes a client; only `N:@W:`
starts updates. A watch after an unwatched change receives an immediate catch-up
`N:@S:` update/delta. `Instances.remove(id)` explicitly deletes a model and
sends `N:@D:"Type#id"` to clients that received it. Removing a model from an
application collection alone does not remove its strong `Instances` registration:
call `remove` when it is truly deleted. Client GC reports `N:@D:` on a
best-effort basis where `WeakRef` and `FinalizationRegistry` are available.

Properties beginning with `_` and all functions are stripped from serialized objects.

#### Delta Update Modes

When a signal's value changes, the server may send only the diff instead of the full value:

| Mode     | Applies when                                               | Effect on client                                                     |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| _(none)_ | General case                                               | Full replacement: `sig.value = newValue`                             |
| `seal`   | The signal will never change again                         | Keep the value and release the signal subscription                   |
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
    └── model.ts        Proxy facade factory and legacy reflected-model constructor
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

**A value travels once per client.** Once a client holds a signal and is
watching it, later serializations send `{"@S": <id>}` alone. So a method with a
bulky answer should return the signal that already carries it rather than its
value — `return {diff: this.diff}`, not `return {diff: this.diff.value}`.

**Settled data opts out of the protocol.** `rpc.markFinal(sig)` promises a
signal will never change again. It serializes with `"f": 1`, so observing it
produces no `@W` and the server never subscribes to it; clients already
watching it receive a debounced `N:@S:<id>,null,"seal"` update and stop treating
it as watched. The server drops its subscription immediately and batches seal
notifications for one second. The promise is permanent: a reconnect or process
change never makes a held signal live again.
Two costs follow from "never watched": a final signal is only weakly held on
the client, so it is always re-sent inline rather than as a bare `{"@S": id}`
ref.

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
│    sees "@S" → calls            │  signals: Map<id,WeakRef>    │            │
│    getOrCreateSignal(7,0)       │  watchBatch / unwatchBatch   │ ── 10ms ─▶ │
│                                 └────────────┬─────────────────┘ global flush│
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
|  `@W`  | c→s | `id,id,...`       | subscribe to these signal ids                    |
|  `@U`  | c→s | `id,id,...`       | unsubscribe                                      |
|  `@M`  | c→s | `"Type#id",...`  | refresh held model facades by marker            |
|  `@S`  | s→c | `id,value[,mode]` | signal `id` changed or was sealed                 |

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
  (registered in             "id":{"v":42},                  data)  via
   Instances with            "title":{"v":"Hello"}}        modelRegistry
   type "Thread")

  obj._private        ──▶   (dropped)
  obj.method          ──▶   (dropped — replaced by RPC stubs on client)
```

`@M` handling is eager: it iterates own props, inlines their signal values
without separate IDs (so `Signal.toJSON()` never runs), and strips
`_`-prefixed and function props.

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
           watchBatch.add(7)  ─── 10ms global flush ──▶  N:@W:7,8,12  ─▶  subs.get(7).add(client)
                                                                  if first watcher:
                                                                    sig.subscribe(notify)
 component unmounts
   effect disposed
     └─▶ unwatched()
           unwatchBatch.add(7) ── 10ms global flush ─▶  N:@U:7
             ▲                                             ▲
             └─ a remount before the flush cancels it ─────┘
 client disconnects
   cleanup()  ───────────────────────────────────────▶  clients.delete(id)
                                                        reflection.removeClient(id)
                                                          - drop from all subs sets
                                                          - purge lastSentValues
                                                          - dispose source signal subscriptions
```

Batching coalesces the "20 signals arrive in one response, 20 effects
subscribe on the same tick" case into one `@W` frame.

Client reflection caches are weak where the runtime supports `WeakRef` and
`FinalizationRegistry`: signal id → signal, model marker → facade, and model →
signal index entries do not by themselves keep unwatched objects alive. Active
signals are still held strongly by `activeSignals` while they are watched so the
client can deterministically send `@U` and replay subscriptions on reconnect.
Root objects, signal values, reflected model facades held by application code,
and Preact subscriptions remain ordinary strong references; once those are gone,
the weak reflection entries can be collected and opportunistically swept.

On reconnect, the client preserves existing roots, signals, and model facades, but marks cached models stale until a full snapshot refreshes them.
The fresh `@R` root snapshot refreshes signal values and rebinds signal ids when a different backend process owns the connection.
Active models omitted from the root are refreshed through `M{id}:@M:...`; only fields whose model snapshot has arrived can subscribe through `@W`.
Unrelated root signals can subscribe while a model refresh is pending.
Unobserved models remain stale until a field becomes observed, including when the new connection uses the same server process or the existing transport reopens.
A root that the same process sends again on a live connection changes no subscription and marks no model stale.
A signal that a stale model shares with the latest root snapshot or a fresh model subscribes immediately, because that source already supplied its current wire id.

For a model returned by a method and omitted from the latest root snapshot, sending the last field's `@U` also marks the model stale.
The application may explicitly remove its registration while client code still holds the facade.
Observing that facade again requests `@M` before sending `@W`, preserving the facade and its field signals while refreshing their values and wire ids.
Invalidation happens when the batched unwatch is sent, so a remount that cancels the unwatch does not cause a model refresh.
Refresh requests use the same batched flush as `@W`: observations in one flush share a single `@M` for all their stale models, a refresh whose last observer leaves before the flush is not sent, and concurrent observations share an in-flight refresh.
A response received after the last observer leaves does not start subscriptions.
An unresolved marker or failed refresh leaves the cached values in place without subscribing to stale ids; a later observation can retry.
A later full payload for that model, such as a method result, also subscribes its observed fields.
Sealed signals remain final and do not trigger reacquisition or subscription traffic.

Only explicit protocol identities are preserved: `@S` signals and `@M` model
facades. The top-level plain root object can be updated in place for ergonomics,
but unbranded nested arrays and plain objects are replaced instead of reconciled
by index or shape. Held facades that are not present in the new root can recover
when the server process can resolve their `Type#id` marker from its `Instances` registry or an application resolver that reconstructs evicted models.
Client-held references do not pin server resources. Explicit deletion uses `@D`;
there is no automatic server eviction policy.

The server includes connection metadata as a second `@R` parameter:
`{connectionId, processId, resumed}`. `connectionId` is opaque and can be fed
back into `RPC.addClient(transport, connectionId)` on a later WebSocket
connection. `processId` tells the client which server process produced the
snapshot, and `resumed` tells whether this connection replaced active retained
state for that id. Once a client has disconnected and cleanup has run, a later
connection with the same id is not reported as resumed. If the second `@R`
parameter is absent, the client treats any snapshot after the initial root as an
unknown/new process and clears raw signal-id mappings before hydration. For
reconnectable transports (`onOpen` present), `RPCClient.ready` stays pending if
the transport disconnects before the first root and never opens again; callers
that need a hard failure should wrap it in their own timeout or abort signal.

---

## Proxy facades

The client no longer needs a per-type constructor to reflect a model. `@M`
serialization already carries the server type, wire id, and the complete set of
serialized signal properties for that instance. `ClientReflection` uses that
information to build a stable cached Proxy facade.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  createReflectedModelFacade(ctx, data)                                      │
│                                                                             │
│  ┌──────────────── discovered signal props ─────────┐                       │
│  │                                                  │  The @M reviver       │
│  │  data[p] is Signal?                              │  already created the │
│  │  ── yes ─▶ computed(() => data[p].value)         │  inner signals.      │
│  └──────────────────────────────────────────────────┘                       │
│                                                                             │
│  ┌──────────────── unknown string property ─────────┐                       │
│  │                                                  │                       │
│  │  model.rename → cached function                  │                       │
│  │  function(...args) → rpc.call(`${wireId}#rename`)│  instance route       │
│  └──────────────────────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

UI binds to `model.title.value`, which tracks the computed wrapping the remote
signal. Method properties are created lazily and cached for stable identity. The
Proxy deliberately does not synthesize promise-like properties such as `then`
or `catch`, and symbol properties pass through normally. String keys, including
odd method names like `"0"`, are valid method candidates because reflected
models are plain objects rather than arrays.

`createReflectedModel(signalProps, methods)` remains as a compatibility wrapper
for older clients or custom facades. Its explicit lists are now hints, not a
requirement: all serialized signals are discovered anyway, and methods not in
the legacy list still work through the Proxy. If the server does not actually
have the method, the RPC response rejects with `Method not found: <name>`.

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

- **Signal identity** — model properties use `Type#id.propertyName`; standalone
  signals use stable wire IDs (`WeakMap<Signal,id>`). The client dedupes by ID.
- **Instance identity** — `Instances.nextId()` skips occupied slots and
  ratchets past any `register(id, …)` so storage-hydrated ids and fresh ids
  never collide.
- **At-most-once push** — `lastSentValues` gates notifications by `===`.
  Redundant `sig.value = same` writes never touch the wire.
- **Lazy fan-out** — a server signal with zero watchers has zero
  `.subscribe()` callbacks attached to it.
- **Transport-agnostic** — `Transport = { send(str), onMessage(cb), onOpen?(cb), onClose?(cb), ready? }`.
  WebSocket, MessagePort, stdin/stdout all fit.
