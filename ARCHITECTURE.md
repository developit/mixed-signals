# mixed-signals

General-purpose RPC with live reactivity. A server-side value — Signal, Model,
plain object, function, or Promise — becomes a live client-side counterpart
that stays in sync automatically, with identity preserved across round trips.

No manual declaration on either side. Reactivity is the subscription protocol.
Refcounts are the lifecycle protocol.

---

## Concepts

| Concept            | Description                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Transport**      | `{ send(str), onMessage(cb), ready? }`. WebSocket, postMessage, MessagePort, stdin/stdout all fit.                               |
| **Handle**         | Any value with identity: Signal, Model, plain object with reactive/handle slots, function, Promise. Keyed by `<kind><n>` id.     |
| **Kind**           | Single char prefix on every handle id. `s`=signal, `o`=object (Model or plain), `f`=function, `p`=promise.                       |
| **Shape**          | Cached description of an object's keys + slot kinds. Sent inline once per (client, shape), referenced by numeric id afterward.   |
| **Brand**          | Hidden registered symbol on every hydrated value. Lets the serializer emit `{@H:id}` when a value is passed back to its owner.   |
| **Handles**        | Single server registry: id ↔ value, shape cache, model-name cache, per-client refcounts, sent-handle tracking.                   |
| **Reflection**     | Signal subscription manager on the server; still owns lazy fan-out, per-client delta tracking, and `@S` push.                    |
| **Hydrator**       | Client-side counterpart to `Serializer`. Builds Proxies, signals, callables, and promises from `@H` markers.                    |
| **Retention**      | Server policy governing when orphaned handles get freed: `disconnect`, `ttl`, or `weak`. Default is `ttl` with a 30s idle timer. |

## Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  SERVER                                                          │
│                                                                  │
│  root object (ctx)                                               │
│    └─ ctx.projects.create(...)     ← RPC routes by dotted path   │
│    └─ <handleId>#<method>(...)     ← or by handle id             │
│                                                                  │
│  RPC ──── Reflection ──── Handles (shared)                       │
│   │          │                │                                  │
│   │   subscriptions      id↔value, refcounts,                    │
│   │   delta push         shape + model-name caches               │
│   │                                                              │
│  Transport (WebSocket send/onMessage)                            │
└────────────────────────┬─────────────────────────────────────────┘
                         │  compact text protocol
┌────────────────────────┴─────────────────────────────────────────┐
│  CLIENT                                                          │
│                                                                  │
│  RPCClient ──── ClientReflection ──── Hydrator                   │
│   │                   │                   │                      │
│   │        batched @W/@U/@H-,    Proxies for Models & plain      │
│   │        outbound calls/       objects, callable proxies,      │
│   │        notifications         live Signals, live Promises     │
│   │                                                              │
│  Transport                                                       │
└──────────────────────────────────────────────────────────────────┘
```

### Wire protocol

Framing is unchanged from v0.2: `M/N/R/E` with `<type><corrId>:<method>:<payload>`.
The reserved methods grew:

| method | dir | payload                     | meaning                               |
| :----: | :-: | --------------------------- | ------------------------------------- |
|  `@R`  | s→c | `<root>`                    | initial root delivery                 |
|  `@W`  | c→s | `id,id,...`                 | subscribe to these signal ids         |
|  `@U`  | c→s | `id,id,...`                 | unsubscribe                           |
|  `@S`  | s→c | `id,value[,mode]`           | signal update (with optional delta)   |
|  `@H-` | c→s | `id,id,...`                 | release these handles (refcount --)   |
|  `@P`  | s→c | `promiseId,value`           | promise handle resolved               |
|  `@PE` | s→c | `promiseId,{message}`       | promise handle rejected               |

### The `@H` marker

Every structural reference on the wire looks like this:

```
{"@H":"s42","v":0}                               // signal, id=s42, inline value
{"@H":"s42"}                                     // signal short-ref (client already has it)
{"@H":"o17","sh":[["id","name"],[1,1]],          // object, first emission:
  "mn":[3,"Project"],"n":3,"s":5,                //   shape inline (keys+kinds), model-name inline
  "d":[{"@H":"s1","v":"42"},{"@H":"s2","v":"X"}]}//   data array in shape order
{"@H":"o17","s":5,"n":3,"d":[…]}                 // object, repeat emission: no shape/mn preludes
{"@H":"o17"}                                     // object short-ref
{"@H":"f11"}                                     // function handle — call via Mx:"f11":args
{"@H":"p7"}                                      // pending promise — settled later via @P/@PE
```

Kinds live in the id's first character so parsing is `id[0]`. No extra field
to read, no format ambiguity.

### Method routing

| Call                  | Dispatch                                                  |
| --------------------- | --------------------------------------------------------- |
| `"foo.bar.baz"`       | dotted path on the server root                             |
| `"<id>#method"`       | method on a specific handle (Model/plain object/function) |
| `"<id>"`              | bare function-handle call (for `f<n>` ids)                |

### Client → server values

A Proxy / Signal / Promise / function on the client that was originally handed
down by the server is **branded** (non-enumerable registered symbol). The
client uses a `JSON.stringify` replacer that detects the brand and re-emits
`{@H:id}` in call arguments; the server uses a matching reviver that resolves
the id back to the live object. Identity is preserved end to end with no
API ceremony.

---

## Shape cache

Shapes are the key efficiency lever. A shape is `{keys: string[], kinds: SlotKind[]}`.
Slot kinds are `0=plain JSON`, `1=Signal`, `2=Handle (nested)`.

- Shape ids are allocated per process, shared across clients.
- `Handles.hasShape(clientId, shapeId)` decides whether to send the shape
  inline on a given emission. First use: full `sh` prelude. Subsequent uses:
  bare shape id reference.
- Model names work the same way, independently, keyed by constructor.

Two plain objects with the same keys share a shape; ten thousand instances of
a Model share one shape and one name per client. Steady-state traffic after
warm-up is a bare `{"@H":"o17","s":N,"n":M,"d":[…]}` per object — no key
names, no type strings, no redundant shape info.

---

## Refcounting + FinalizationRegistry

Client:

1. Every `Hydrator.hydrate(...)` stores the proxy in a `Map<id, WeakRef>` and
   registers it with a `FinalizationRegistry`.
2. When the proxy becomes unreachable, the finalization callback adds the id
   to a batch that flushes as `N:@H-:id,id,...` on a 16ms debounce.
3. Watch/unwatch/release all share the same batching pattern. Under a render
   burst, 500 signals → one watch frame. Under a GC burst, N proxies → one
   release frame.

Server:

1. `@H-` decrements the per-client refcount on each listed handle.
2. When a handle's refcount across all clients drops to zero, the retention
   policy decides:
   - `disconnect` — no action on release; drop at disconnect time only.
     (Useful for stable long-lived clients; not the default because of
     reconnect risk.)
   - `ttl` (default, 30s idle) — handle becomes a candidate for a sweep
     scheduled on a `setTimeout`. If it stays orphaned past `idleMs`, it's
     dropped. Any activity — a new emission, a method call — calls `touch()`
     and extends its life.
   - `weak` — drop the handle immediately. Use when the real domain object
     lifecycle is managed elsewhere and this RPC layer shouldn't be the
     retention authority.

Environments without `FinalizationRegistry` fall back silently to disconnect/TTL.
No manual `dispose()` exists anywhere.

---

## Subscription lifecycle (unchanged in spirit)

```
 client                                              server
 ──────                                              ──────
 component mounts
   effect reads sig.value
     └─▶ watched()
           scheduleWatch(id)   ── 1ms ──▶  N:@W:s7,s8,s12
                                           subs.get(s7).add(client)
                                           first watcher?
                                             sig.subscribe(notify)
 component unmounts
   effect disposed
     └─▶ unwatched()
           setTimeout(10ms)                  ← debounce: quick remount stays up
             └─▶ scheduleUnwatch(id) ─▶ N:@U:s7
 proxy unreachable
   FinalizationRegistry fires
     └─▶ scheduleRelease(id) ─ 16ms ─▶ N:@H-:o17,s7,f11
                                        refcount-- per handle
                                        TTL sweep scheduled
 client disconnects
   cleanup()                     ─▶ clients.delete(id)
                                    reflection.removeClient(id)
                                    handles.releaseAllForClient(id)
                                      retention.kind === 'disconnect'?
                                        drop orphaned
```

---

## Proxy construction

For every `@H:o…` the hydrator builds a spine object containing live signals
for SIGNAL slots and hydrated values for the rest, then wraps it in a Proxy:

```ts
new Proxy(spine, {
  get(t, key) {
    if (key === BRAND_REMOTE) return t[BRAND_REMOTE];
    if (key === 'then' || 'catch' || 'finally' || 'toJSON') return undefined;
    if (key in t) return t[key];
    // Synthesize a method stub for unknown keys. No method list anywhere.
    return cachedMethod(id, key);
  },
  has(t, key) { /* 'then' etc. say false so we aren't a thenable */ },
  ownKeys(t) { /* hide BRAND_REMOTE */ },
  // …
})
```

Thenable guards matter: awaiting a Proxy would otherwise dispatch `.then`
to the server, a classic foot-gun for live-remote objects.

---

## File layout

```
mixed-signals/
├── shared/
│   ├── brand.ts         BRAND_REMOTE + RemoteBrand type
│   ├── handles.ts       Handles registry (id↔value, shapes, names, refs)
│   ├── shapes.ts        shape classification + signatures
│   ├── serialize.ts     Serializer (value → wire JSON with @H markers)
│   ├── hydrate.ts       Hydrator (wire JSON → Proxies/Signals/Promises)
│   ├── protocol.ts      frame parse/format, method-name constants
│   └── disposable.ts    Symbol.dispose shim (kept for parity with signals-core)
├── server/
│   ├── rpc.ts           multi-client RPC host + retention + routing
│   ├── reflection.ts    signal subscriptions, delta diffing, @S push
│   ├── model.ts         createModel(name, factory) — name stamp on ctor
│   ├── forwarding.ts    broker chain: prefix/unprefix @H ids
│   ├── memory-transport.ts
│   └── index.ts
└── client/
    ├── rpc.ts           RPC client, outbound brand-aware replacer
    ├── reflection.ts    outbound batching, promise settlement, HydrateEnv impl
    ├── model.ts         deprecated no-op shim for createReflectedModel
    └── index.ts
```

Two bundles (`./server`, `./client`). One peer dep: `@preact/signals-core ≥1.14`.

---

## Invariants

- **Handle identity** — one server value = one handle id for the process
  lifetime (while it's live). Re-serializing the same value yields the same
  id; the client dedupes on it.
- **At-most-once body emission per (client, handle)** — `hasSentHandle` gates
  full emission; repeat emissions are bare `{@H:id}`.
- **Refcount symmetry** — exactly one retain per new emission, exactly one
  release per `@H-`. Short refs do not retain again.
- **No push without watch** — a server Signal with zero watchers has zero
  `.subscribe()` callbacks attached.
- **No pull without identity** — plain JSON dictionaries are inlined without
  an id; only values with structural identity (Models, plain objects with
  signal/handle slots, functions, promises) get registered.
- **Thenables can't be proxies** — Proxy traps for `then`/`catch`/`finally`
  return `undefined` to keep the JS runtime from conflating a live-remote
  object with a Promise.
- **Transport-agnostic** — `Transport = { send(str), onMessage(cb), ready? }`.
