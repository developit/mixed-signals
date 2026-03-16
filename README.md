# signal-wire

Reflection & RPC for [`@preact/signals-core`](https://github.com/preactjs/signals) — synchronize reactive model state between server and client over any transport (WebSocket, etc).

## Install

```sh
npm install signal-wire @preact/signals-core
```

## How it works

**signal-wire** reflects server-side models built with `@preact/signals-core` to connected clients in real-time. Signals on the server are serialized with identity markers, and the client reconstructs them as local signals that stay in sync via a lightweight wire protocol.

- **Server** models use `createModel()` from `signal-wire/server` (a thin wrapper around `@preact/signals-core`'s `createModel`)
- **Client** models use `createReflectedModel()` from `signal-wire/client` to create local proxies that mirror server state
- An **RPC** layer handles method calls (client → server) and signal updates (server → client)
- Delta compression for arrays (append), objects (merge), and strings (append) minimizes bandwidth

## Usage

### Server

```ts
import {createModel, RPC} from 'signal-wire/server';
import {signal} from '@preact/signals-core';

const Counter = createModel(() => {
  const count = signal(0);
  return {
    count,
    increment() { count.value++; },
  };
});

const rpc = new RPC();
rpc.registerModel('Counter', Counter);

const root = new Counter();
rpc.expose(root);

// For each connected client (e.g. via WebSocket):
const removeClient = rpc.addClient({
  send: (data) => ws.send(data),
  onMessage: (cb) => ws.on('message', cb),
});
```

### Client

```ts
import {createReflectedModel, RPCClient} from 'signal-wire/client';

const Counter = createReflectedModel(
  ['count'],       // signal properties to reflect
  ['increment'],   // methods to proxy
);

const ctx = {rpc: null as any};
const rpc = new RPCClient(transport, ctx);
ctx.rpc = rpc;

rpc.reflection.registerModel('Counter', Counter);

await rpc.ready;
const counter = rpc.root; // reflected Counter instance
console.log(counter.count.value); // reactive!
await counter.increment();        // calls server method
```

## License

MIT

## API

_Generated from TypeScript declarations._

### `signal-wire/server`

#### `createModel`

- Kind: **Function**
- Signatures:
  - `(factory: ModelFactory<TModel, TFactoryArgs>) => ModelConstructor<TModel, TFactoryArgs>`

#### `Instances`

- Kind: **Class**
- Constructor:
  - `new Instances() => Instances`
- Methods:
  - `get(id: string) => any`
  - `getId(instance: any) => string | undefined`
  - `nextId() => string`
  - `register(id: string, instance: any) => void`
  - `remove(id: string) => void`

#### `Reflection`

- Kind: **Class**
- Constructor:
  - `new Reflection(rpc: any, instances: Instances) => Reflection`
- Methods:
  - `getInstanceId(instance: any) => string`
  - `getModelType(val: any) => string | undefined`
  - `isModel(val: any) => boolean`
  - `registerModel(name: string, Ctor: (args: any[]) => any) => void`
  - `removeClient(clientId: string) => void`
  - `serialize(value: any, clientId?: string) => any`
  - `unwatch(clientId: string, signalId: number) => void`
  - `watch(clientId: string, signalId: number) => void`

#### `RPC`

- Kind: **Class**
- Constructor:
  - `new RPC() => RPC`
- Methods:
  - `addClient(transport: Transport, clientId?: string) => () => void`
  - `expose(root: any) => void`
  - `notify(method: string, params: any[], clientId?: string) => void`
  - `registerModel(name: string, Ctor: (args: any[]) => any) => void`
  - `send(clientId: string, msg: any) => void`
- Properties:
  - `instances: Instances`

#### `Transport`

- Kind: **Interface**
- Methods:
  - `onMessage(cb: (data: { toString: unknown }) => void) => void`
  - `send(data: string) => void`
- Properties:
  - `ready: Promise<void>`

### `signal-wire/client`

#### `ClientReflection`

- Kind: **Class**
- Constructor:
  - `new ClientReflection(rpc: any, ctx: WireContext) => ClientReflection`
- Methods:
  - `createModelFacade(serialized: any) => any`
  - `getOrCreateSignal(id: number, initialValue: any) => Signal<any>`
  - `handleUpdate(id: number, value: any, mode?: string) => void`
  - `registerModel(typeName: string, ctor: any) => void`

#### `createReflectedModel`

- Kind: **Function**
- Signatures:
  - `(signalProps: string[], methods: string[]) => ModelConstructor<T, tuple>`

#### `RPCClient`

- Kind: **Class**
- Constructor:
  - `new RPCClient(transport: Transport, ctx: WireContext) => RPCClient`
- Methods:
  - `call(method: string, params?: any) => Promise<any>`
  - `notify(method: string, params?: any[]) => void`
  - `onNotification(cb: (method: string, params: any[]) => void) => () => void`
- Properties:
  - `ready: Promise<void>`
  - `reflection: ClientReflection`
  - `root: any`

#### `Transport`

- Kind: **Interface**
- Methods:
  - `onMessage(cb: (data: { toString: unknown }) => void) => void`
  - `send(data: string) => void`
- Properties:
  - `ready: Promise<void>`

#### `WireContext`

- Kind: **Interface**
- Properties:
  - `rpc: { call: unknown }`

