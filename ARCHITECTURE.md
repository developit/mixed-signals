# mixed-signals

General-purpose RPC built around three lifecycle tiers and one wire marker.
Signals, Models, plain objects, functions, and Promises all cross the
transport with identity and the *minimum* lifecycle machinery their kind
requires - no more, no less.

---

## Concepts

| Concept            | Description                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Transport**      | `{ send(str), onMessage(cb), ready? }`. WebSocket, postMessage, MessagePort, stdin/stdout all fit.                           |
| **Handle**         | Any value with wire identity: Signal, object (Model or class instance with methods), function, Promise.                      |
| **Kind**           | Single-char prefix on every handle id. `s`=signal, `o`=object, `f`=function, `p`=promise.                                    |
| **Shape**          | Cached per-client description of an `o` handle's data keys + slot kinds. Inline once, referenced by numeric id afterward.    |
| **Brand**          | Hidden registered symbol on every hydrated value. Lets the serializer emit `{@H:id}` when a value round-trips to its owner. |
| **Handles**        | Single server registry: id ↔ value, shape cache, model-name cache, per-client refcounts (for `o` / `f` only).               |
| **Reflection**     | Signal subscription manager on the server: lazy fan-out, per-client delta tracking, `@S` push.                               |
| **Hydrator**       | Client-side counterpart. Builds Proxies, signals, callables, promises from `@H` markers.                                     |
| **Retention**      | Server policy for reclaiming tier-2 handles with no holders. Default `ttl` 30s; also `disconnect` and `weak`.                |

---

## The three lifecycle tiers

| Kind | Tier | How release is signaled | GC required? | Works on old engines |
|------|------|-------------------------|--------------|----------------------|
| Signal (`s`) | 1 - subscription | `@W` / `@U` notifications | No | Always |
| Object/Function (`o`/`f`) | 2 — refcounted | `@D` batched from `FinalizationRegistry` + optional `Symbol.dispose` | Yes (with server policy as fallback) | Degrades to policy‐only |
| Promise (`p`) | 3 — one‐shot | `@P` / `@E` settlement frame | No | Always |

**Tier 1 (signals)** is the cleanest case. `signal(v, {watched, unwatched})`
gives the server deterministic, engine-guaranteed hooks for "first reader"
and "last reader." Subscription *is* retention - the server only holds a
live `.subscribe(...)` while at least one client is `@W`-watching. Signals
are never registered with `FinalizationRegistry`, never appear in `@D`
release batches, never carry a refcount.

**Tier 2 (objects, functions)** has no built-in signal like `watched`, so
the client uses `FinalizationRegistry` to observe when a Proxy or callable
stub becomes unreachable and sends a coalesced `@D` batch. The server
decrements refcounts; once they hit zero across all clients, the retention
policy decides when to free the entry. `Symbol.dispose` on the Proxy is a
deterministic opt-in - `using proxy = ...` or a manual dispose call
short-circuits GC.

**Tier 3 (promises)** has an explicit end-of-life: it settles exactly once.
Promises get a pid from a tiny counter on the server; a `.then/.catch`
handler is attached; when the Promise settles, one `@P` or `@E` frame
fires. No refcount. No release. Worst case - client stopped caring - is
one wasted frame per promise. O(1), fine.

**Plain objects aren't handles.** A value with no methods and no identity
stamping has no reason to be tracked: the client can't subscribe to updates
on it, can't reach methods that aren't there, and pass-by-value is exactly
right. Plain objects are inlined as pure JSON, and the recursion still
picks up any nested Signals / Models / functions / Promises inside.

---

## Upgrade rule (what becomes an `o` handle)

An object becomes an `o` handle iff:

1. It was stamped by `createModel(name, factory)` (Model), **or**
2. It has at least one non-`_`-prefixed method anywhere in its prototype
   chain, up to (but not including) `Object.prototype`.

Otherwise it's plain JSON. Arrays and values carrying `.toJSON()` (Dates,
user-defined opt-outs) always serialize via their `toJSON`, matching
`JSON.stringify`'s own rules.

Methods are **never** placed in the wire data - they're dispatched through
the Proxy trap (`proxy.foo(...)` → `M<id>:o17#foo:args`). Two classes with
identical state keys but different methods therefore share a class id.
Calls to non-existent methods surface a "Method not found" reject.

---

## Wire protocol

Framing: `<type><corrId>:<method>:<payload>` - `M` call, `N` notification,
`R` result, `E` error. Unchanged from the previous version.

### Reserved methods

| method | dir | payload                     | meaning                                 |
| :----: | :-: | --------------------------- | --------------------------------------- |
|  `@R`  | s→c | `<root>`                    | initial root delivery                   |
|  `@W`  | c→s | `id,id,...`                 | subscribe to these signal ids           |
|  `@U`  | c→s | `id,id,...`                 | unsubscribe                             |
|  `@S`  | s→c | `id,value[,mode]`           | signal update (optional delta mode)     |
|  `@D`  | c→s | `id,id,...`                 | drop `o`/`f` handles (refcount --)      |
|  `@P`  | s→c | `pid,value`                 | promise resolved                        |
|  `@E`  | s→c | `pid,{message}`             | promise rejected                        |

### The `@H` marker

Every structural reference carries a single top-level marker. All
reserved fields are short letters:

| field | meaning |
|:---:|---|
| `@H` | handle id, kind-prefixed (s/o/f/p) |
| `c`  | class reference — string `"<id>#<name>"` or `"<id>"` on first emission, numeric id afterward |
| `p`  | property list (first emission of a class only) — comma-separated keys in `d` order |
| `d`  | data payload — positional array for cached classes, keyed object for ad-hoc handles |
| `v`  | inline signal value (inside `@H:s*` only) |

```json
{"@H":"s42","v":0}                               // signal, inline value (first time)
{"@H":"s42"}                                     // signal, bare reference

{"@H":"o17",                                     // cached-class instance, first time:
 "c":"1#Counter",                                //   class id + name (stringified)
 "p":"count,name",                               //   property list
 "d":[{"@H":"s1","v":0},                         //   positional data
      {"@H":"s2","v":"default"}]}

{"@H":"o18",                                     // later instance of same class:
 "c":1,                                          //   numeric ref; no p needed
 "d":[{"@H":"s3","v":5},{"@H":"s4","v":"y"}]}

{"@H":"o19",                                     // ad-hoc object (ctor === Object):
 "d":{"count":{"@H":"s5","v":0},"ttl":60}}       //   keyed data, no c/p

{"@H":"o17"}                                     // same instance reuse — bare
{"@H":"f7"}                                      // function — callable via M…:f7:args
{"@H":"p11"}                                     // promise — settled later via @P/@E
```

Short refs work because the receiver has already hydrated the body on a
previous emission. The serializer tracks "did I tell this client about
this id yet?" per client; the class-id cache is independent of the
handle-id cache. On the client, each (class id) gets a synthetic ctor,
and every instance is built as `Object.create(ctor.prototype)` so
`value instanceof rpc.classOf('Counter')` works.

**Cacheable vs ad-hoc** is decided by `ctor === Object`:

- `new Counter()`, `new Project()`, `createModel`-backed factories →
  cacheable → `c` + `p` (first) / `c` (later) + positional `d`.
- `{foo: 1, bar() {}}`, `Object.create(null)` with methods → ad-hoc →
  no `c` or `p`, keyed `d`.

Cached classes have one constraint: property names cannot contain `,`
(the `p` delimiter). The serializer throws a clear error at emit time
if that happens. Use a plain object if you need arbitrary keys.

### Method routing

| Call string       | Dispatch                                                      |
| ----------------- | ------------------------------------------------------------- |
| `"foo.bar.baz"`   | dotted path on the server root                                |
| `"<id>#method"`   | method on a specific handle (Model / class instance / literal with methods) |
| `"<id>"` (for `f*`) | bare function-handle call                                    |

### Client → server values

Any Proxy / Signal / callable / Promise the client received carries a
non-enumerable registered `Symbol.for('mixed-signals.remote')` brand. The
client's outbound `JSON.stringify` replacer detects the brand and emits
`{"@H":"<id>"}`; the server's inbound reviver resolves the id back to the
original live value. Identity is preserved end to end with no user API.

---

## Wire Protocol by Example

Assume this server:

```ts
const Counter = createModel('Counter', () => {
  const count = signal(0);
  const name = signal('default');
  return {
    count,
    name,
    increment() { count.value++; },
    rename(next) { name.value = next; return {ok: true}; },
  };
});

const rpc = new RPC(new Counter());
```

### 1. Connect + root handshake

Server sends the root on connect. The class def is inline on first use
for this client (string `c`, full `p`).

```
S → C   N:@R:{"@H":"o0","c":"1#Counter","p":"count,name",
                "d":[{"@H":"s1","v":0},{"@H":"s2","v":"default"}]}
```

On the client, the hydrator allocates a synthetic `Counter` ctor, caches
it as class id 1, builds a `Proxy` over `Object.create(ctor.prototype)`
filled with two live Signals, and `rpc.root` resolves. `rpc.classOf('Counter')`
now returns that ctor so `rpc.root instanceof rpc.classOf('Counter')`
evaluates true.

### 2. Subscribe + server push with delta

The UI reads `counter.count.value`. `watched` fires, the watch-batch
flushes after ~1ms:

```
C → S   N:@W:s1
```

Now `counter.count.value = 7` on the server:

```
S → C   N:@S:s1,7
```

Later the server does `counter.count.value = 8`:

```
S → C   N:@S:s1,8
```

String/array/object deltas use a third field:

```ts
counter.name.value = "default+suffix"   // old was "default"
// → S → C   N:@S:s2,"+suffix","append"
```

### 3. Method call on a Model

```ts
await client.root.increment();
```

Proxy trap synthesizes `o0#increment`:

```
C → S   M1:o0#increment:
S → C   R1:null              ← void return
```

And a method with an argument and a structured return:

```ts
await client.root.rename('hi');
```

```
C → S   M2:o0#rename:"hi"
S → C   R2:{"ok":true}       ← plain JSON, no handle needed
```

### 4. Non-Model class auto-upgrades

```ts
class Project {
  id = signal('42');
  rename(next) { this.id.value = next; }
}
const rpc = new RPC({project: new Project()});
```

The root `{project}` has no methods of its own, but it IS exposed via
`createRoot` which gives it `o0` identity — so it goes out as an ad-hoc
handle with keyed `d`. `project` is a stable-ctor class instance with a
method → cacheable class, but **no** `#<name>` (the ctor wasn't
`createModel`-stamped):

```
S → C   N:@R:{"@H":"o0","d":{"project":{"@H":"o1",
                    "c":"2","p":"id",
                    "d":[{"@H":"s1","v":"42"}]}}}
```

The `c:"2"` (no `#`) tells the client "cached class, anonymous." The
client's Proxy still dispatches methods: `project.rename('new')` →
`M1:o1#rename:"new"`. `instanceof` works if the user grabs the ctor via
`client.classOf` — but without a name there's nothing to look up, so
the class identity is purely a serialization detail in this case.

### 5. Plain data: no handle at all

```ts
rpc = new RPC({
  getUser(id) { return { id, name: 'jason', email: 'x@y.z' }; },
});
```

```
C → S   M1:getUser:7
S → C   R1:{"id":7,"name":"jason","email":"x@y.z"}
```

Pure JSON. No id allocated, no refcount, no cleanup - the return is
pass-by-value exactly as you'd expect.

### 6. One method changes everything

Same `getUser` but now the result has a method:

```ts
getUser(id) {
  return {
    id,
    name: 'jason',
    refresh() { return reload(id); },
  };
}
```

```
C → S   M1:getUser:7
S → C   R1:{"@H":"o2","d":{"id":7,"name":"jason"}}
```

`refresh` is filtered out of `d` (methods aren't data); the result is an
ad-hoc `o` handle (keyed `d`, no `c` — the returned literal has
`ctor === Object`); `result.refresh()` goes through the trap as
`o2#refresh`.

### 7. Repeat emission → bare reference

Call `getUser(7)` twice and the server returns the same object instance:

```
C → S   M2:getUser:7
S → C   R2:{"@H":"o2"}      ← full body already known on this client
```

The client's hydrator looks `o2` up in its `Map<id, WeakRef>` and returns
the existing Proxy - reference identity preserved.

### 8. Function handle

```ts
makeAdder(x) { return (y) => x + y; }
```

```
C → S   M1:makeAdder:5
S → C   R1:{"@H":"f1"}

C → S   M2:f1:3              ← bare-id call dispatches the function
S → C   R2:8
```

### 9. Pending promise

```ts
delayed() { return new Promise(r => setTimeout(() => r('done'), 50)); }
```

```
C → S   M1:delayed:
S → C   R1:{"@H":"p1"}       ← pending-promise marker

(50ms later)

S → C   N:@P:p1,"done"       ← settlement frame
```

Client's hydrator kept a pending `Promise` keyed by `p1`; arrival of `@P`
settles it.

Promise handles never go through the refcount system. They allocate a pid
from a small counter, fire once, and are done. A rejection looks the same
but with `@E` and a `{message}` payload.

### 10. Passing a received Proxy back as an argument

```ts
const project = await client.root.getProject('42');  // o17
await client.root.inspect(project);                  // server sees original instance
```

Client side, `JSON.stringify` replacer walks the call args. `project`
carries the brand, so instead of stringifying its state, it emits:

```
C → S   M3:inspect:{"@H":"o17"}
```

Server's incoming reviver resolves `o17` to the live server object.
`===` identity is preserved.

### 11. Release (tier 2)

Client code drops the last reference to `project`:

```ts
project = null;     // proxy is now unreachable
```

When the engine runs GC, `FinalizationRegistry` fires on the token. The
client's release batch coalesces for ~16ms, then:

```
C → S   N:@D:o17
```

Server decrements the refcount for `o17` under client `c1`. If the count
across all clients reaches zero:

- `retention: disconnect` → no action (wait for actual disconnect)
- `retention: ttl` → mark for sweep; drop after `idleMs` of no activity
- `retention: weak` → drop immediately

`Symbol.dispose` on the Proxy short-circuits this: `proxy[Symbol.dispose]()`
schedules an immediate release without waiting for GC.

### 12. Disconnect cleanup

Transport closes. Server runs `removeClient(c1)`:

- `reflection.removeClient(c1)` drops every subscription `c1` had and
  unhooks the underlying `sig.subscribe(...)` for signals no other client
  is watching.
- `handles.releaseAllForClient(c1)` decrements every `o`/`f` refcount,
  and scans `c1`'s sent-set for signals no other client has seen - those
  get marked orphaned too.
- Retention runs; by default (`ttl`) an orphan sweep is scheduled. Under
  `disconnect`, orphans are dropped immediately (except the root).

---

## Subscription lifecycle

```
 client                                              server
 ──────                                              ──────
 component mounts
   effect reads sig.value
     └─▶ watched()
           scheduleWatch(id)   ── 1ms ──▶  N:@W:s7
                                           subs.get(s7).add(client)
                                           first watcher? sig.subscribe(push)
 component unmounts
   effect disposed
     └─▶ unwatched()
           setTimeout(10ms)                  ← debounce: quick remount stays up
             └─▶ scheduleUnwatch(id) ─▶ N:@U:s7

 o/f proxy unreachable
   FinalizationRegistry fires
     └─▶ scheduleRelease(id) ─ 16ms ─▶ N:@D:o17,f11
                                       refcount-- per client

 client disconnects
   transport closes             ─▶ server.removeClient(id)
                                    reflection.removeClient(id)
                                    handles.releaseAllForClient(id)
                                    retention.kind === 'disconnect'?
                                      drop orphaned tier-2 + orphaned signals
```

---

## File layout

```
mixed-signals/
├── shared/
│   ├── brand.ts         BRAND_REMOTE + RemoteBrand type
│   ├── handles.ts       Handles registry (id↔value, class cache, refs)
│   ├── serialize.ts     Serializer: value → wire JSON with @H markers
│   ├── hydrate.ts       Hydrator: wire JSON → Proxies / Signals / Promises
│   ├── protocol.ts      frame parse/format, method-name constants
│   └── disposable.ts    Symbol.dispose shim (kept for parity with signals-core)
├── server/
│   ├── rpc.ts           multi-client RPC host + retention + routing
│   ├── reflection.ts    signal subscriptions, delta diffing, @S push
│   ├── model.ts         createModel(name, factory) - stamps MODEL_NAME_SYMBOL
│   ├── forwarding.ts    broker chain: prefix/unprefix @H ids
│   ├── memory-transport.ts
│   └── index.ts
└── client/
    ├── rpc.ts           RPC client + outbound brand-aware replacer + classOf()
    ├── reflection.ts    outbound batching (@W/@U/@D), promise settlement
    ├── model.ts         deprecated no-op shim for createReflectedModel
    └── index.ts
```

Two bundles (`./server`, `./client`). One peer dep:
`@preact/signals-core ≥1.14`.

---

## Invariants

- **Handle identity** - one server value = one handle id for its lifetime
  in the registry. Re-serializing the same value yields the same id. Every
  client instance of a named class shares a synthetic ctor so `instanceof`
  works across the connection.
- **At-most-once body emission per (client, handle)** -
  `hasSentHandle(clientId, id)` gates full emission; repeats are bare
  `{@H:id}`.
- **Refcount symmetry (tier 2 only)** - exactly one retain per client per
  handle, exactly one release per `@D`. Short refs do not retain again.
- **Tier 1 is subscription-driven** - signals never appear in refcount
  maps, in `FinalizationRegistry` registrations, or in `@D` frames.
- **Tier 3 is fire-and-forget** - promise pids are counter-allocated, never
  refcounted, never released. A dangling pending Promise on the client is
  O(1) cost and converges naturally when the server settles it.
- **Thenable guard** - Proxy traps for `then` / `catch` / `finally` return
  `undefined` so live-remote objects aren't mistaken for promises.
- **No push without watch** - a server Signal with zero watchers has zero
  `.subscribe(...)` callbacks attached.
- **Transport-agnostic** - `Transport = { send(str), onMessage(cb), ready? }`.
