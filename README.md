# mixed-signals

RPC + reflection for [Preact Signals and Models](https://github.com/preactjs/signals): access reactive model state and methods from a server (or worker/tab/etc) as if they lived on the client. Type-safe, minimal magic, and an optimized transport-agnostic protocol (WebSocket, SSE, postMessage, etc).

**Installation:**

```sh
npm install mixed-signals
```

The only dependency is `@preact/signals-core` (>=1.8.0).

## How it works

**mixed-signals** reflects server-side Preact Models and Signals (anything created via `@preact/signals-core`) to connected clients in real-time. Signals on the server are serialized with identity markers, and the client reconstructs them as local signals that stay in sync via a lightweight wire protocol.

- **Server** models use `createModel()` from `signal-wire/server` (a thin wrapper around `@preact/signals-core`'s `createModel`)
- **Client** models use `createReflectedModel()` from `signal-wire/client` to create local proxies that mirror server state
- An **RPC** layer handles method calls (client → server) and signal updates (server → client)
- Delta compression for arrays (append), objects (merge), and strings (append) minimizes bandwidth

## Server API

```ts
import { RPC, Instances, Reflection } from "mixed-signals/server";
import type { Transport } from "mixed-signals/server";
```

### `new RPC(root?)`

Creates an RPC server. Pass `root` to expose it immediately, or call `rpc.expose(root)` later.

```ts
const rpc = new RPC(ctx);
```

### `rpc.expose(root)`

Registers or replaces the root object exposed to clients. The root itself is tracked as instance `"0"`.

### `rpc.addClient(transport, clientId?) → () => void`

Registers a client transport. Returns a cleanup function that disconnects the client and removes all its subscriptions.

```ts
const dispose = rpc.addClient({
  send: (data) => ws.send(data),
  onMessage: ws.on.bind(ws, "message"),
});
ws.on("close", dispose);
```

### `rpc.notify(method, params, clientId?)`

Sends an `N:` notification to one client (if `clientId` is given) or to all connected clients.

### `rpc.instances`

An `Instances` registry. Use it to register model instances so they can be serialized with an `@M` brand and later routed via `{id}#method`.

`Reflection.serialize()` will auto-register reflected models the first time they
cross the wire. Reach for `rpc.instances` when you want explicit ids up front,
or when deleted objects should be removed from the routing table immediately.

```ts
// Register an instance with its wire ID
rpc.instances.register(id, instance);

// Retrieve an instance by ID
rpc.instances.get(id);

// Remove on deletion
rpc.instances.remove(id);

// Allocate the next available ID
const id = rpc.instances.nextId();
```

### `Transport` interface

```ts
interface Transport {
  send(data: string): void;
  onMessage(cb: (data: { toString(): string }) => void): void;
  ready?: Promise<void>; // optional: RPCClient waits before sending
}
```

## Client API

```ts
import { RPCClient, createReflectedModel, ClientReflection } from "mixed-signals/client";
import type { WireContext, Transport } from "mixed-signals/client";
```

### `new RPCClient(transport, ctx)`

Creates an RPC client. `ctx` must satisfy `WireContext` (i.e. expose `rpc.call`—the client itself satisfies this).

```ts
const rpc = new RPCClient(
  {
    send: (data) => ws.send(data),
    onMessage: (cb) => {
      ws.onmessage = (e) => cb(e.data);
    },
    ready: new Promise((r) => ws.addEventListener("open", r, { once: true })),
  },
  ctx,
);
```

### `rpc.call(method, params?) → Promise<any>`

Sends an `M:` call and returns a promise that resolves with the deserialized result (or rejects on an `E:` response). Waits for `transport.ready` if provided.

### `rpc.notify(method, params?)`

Sends an `N:` notification without expecting a reply.

### `rpc.reflection`

The `ClientReflection` instance. Use it to register model constructors.

```ts
rpc.reflection.registerModel("Project", ProjectModel);
```

### `createReflectedModel<T>(signalProps, methods, path?)`

Produces a Preact Model constructor. Each instance exposes:

- **signalProps** — reactive computed properties backed by server signals.
- **methods** — async functions that call the corresponding RPC method and update local signal holders.
- **path** — if provided, routes calls as `path.method` (collection model). If omitted, routes as `{wireId}#method` (instance model).

Pass the server model's instance type as `T` to get compile-time validation that `signalProps` contains only `Signal` properties of `T` and `methods` contains only callable properties of `T`. When `T` is omitted it defaults to `any`, so `signalProps` and `methods` remain plain `string[]` and no constraints are applied.

```ts
const TodosModel = createReflectedModel<TodosApi>(["items"], ["create"], "todos");

const ProjectModel = createReflectedModel<ProjectApi>(
  ["id", "name", "repo", "mainDir", "instructions"],
  ["createIssue", "delete"],
);
```

### `WireContext` interface

```ts
interface WireContext {
  rpc: { call(method: string, params?: unknown[]): Promise<unknown> };
}
```

## Full Usage Example

### Server

**`server/ctx.ts`** — DI container, models, and RPC setup:

```ts
import { signal } from "@preact/signals-core";
import { RPC, createModel } from "mixed-signals/server";
import { container } from "./lib/container.ts";

interface Ctx {
  rpc: RPC;
  todos: InstanceType<typeof Todos>;
}

export const Todo = createModel((ctx: Ctx, data?: { id?: number }) => {
  const id = signal(data?.id ?? Number(ctx.rpc.instances.nextId()));
  const text = signal("");
  const done = signal(false);

  const instance = {
    id,
    text,
    done,
    toggle() {
      done.value = !done.value;
    },
    remove() {
      ctx.todos.remove(id.value);
      ctx.rpc.instances.remove(String(id.value));
    },
  };

  // Manual registration is optional, but useful when ids are part of your domain model.
  ctx.rpc.instances.register(String(id.value), instance);
  return instance;
});

export const Todos = createModel((ctx: Ctx) => {
  const all = signal<InstanceType<typeof Todo>[]>([]);
  const byId = new Map<number, InstanceType<typeof Todo>>();

  return {
    all,
    get(id: number) {
      return byId.get(id);
    },
    add(text: string) {
      const todo = new Todo(ctx);
      todo.text.value = text;
      byId.set(todo.id.value, todo);
      all.value = [...all.value, todo];
      return todo;
    },
    remove(id: number) {
      byId.delete(id);
      all.value = all.value.filter((todo) => todo.id.value !== id);
    },
  };
});

export const ctx = container<Ctx>({
  rpc: () => new RPC(ctx),
  todos: (ctx) => new Todos(ctx),
});

ctx.rpc.registerModel("Todo", Todo);
ctx.rpc.registerModel("Todos", Todos);
```

**`server/index.ts`** — attach WebSocket transport to the RPC server:

```ts
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { ctx } from "./ctx.ts";

const server = createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const dispose = ctx.rpc.addClient({
    send: (data) => ws.send(data),
    onMessage: (cb) => ws.on("message", cb),
  });
  ws.on("close", dispose);
});

server.listen(3000);
```

### Client

**`client/models/todo.ts`** — reflected instance model, typed against the server model:

```ts
import { createReflectedModel } from "mixed-signals/client";
import type { Todo } from "../server/ctx.ts";

// Passing the server model type turns prop/method drift into a type error.
export const TodoModel = createReflectedModel<InstanceType<typeof Todo>>(
  ["id", "text", "done"],
  ["toggle", "remove"],
);
```

**`client/ctx.ts`** — DI container, typed collection facade, and bootstrap:

```ts
import { RPCClient, createReflectedModel } from "mixed-signals/client";
import { container } from "./lib/container.ts";
import { TodoModel } from "./models/todo.ts";
import type { Todos } from "../server/ctx.ts";

const TodosModel = createReflectedModel<InstanceType<typeof Todos>>(
  ["all"],
  ["add", "remove", "get"],
  "todos",
);

interface Ctx {
  rpc: RPCClient;
  todos: InstanceType<typeof TodosModel>;
}

const ws = new WebSocket(location.origin);
const ready = new Promise<void>((resolve) => {
  ws.addEventListener("open", () => resolve(), { once: true });
});

const transport = {
  send: (data: string) => ws.send(data),
  onMessage: (cb: (data: string) => void) => {
    ws.addEventListener("message", (event) => cb(String(event.data)));
  },
  ready,
};

export const ctx = container<Ctx>({
  rpc: (ctx) => {
    const rpc = new RPCClient(transport, ctx);
    rpc.reflection.registerModel("Todo", TodoModel);
    rpc.reflection.registerModel("Todos", TodosModel);
    return rpc;
  },
  // Collection models still arrive from the reflected root graph on connect.
  todos: (ctx) => ctx.rpc.root?.todos,
});

await ctx.rpc.ready;
await ctx.todos.add("Buy milk");
```
