import type {
  RawTransport,
  StringTransport,
  TransportContext,
} from '../shared/protocol.ts';

/**
 * Creates two linked `StringTransport` instances for in-process communication.
 * Messages sent on one end are delivered to the other via `queueMicrotask`.
 */
export function createMemoryTransportPair(): [
  StringTransport,
  StringTransport,
] {
  let handlerA: ((data: {toString(): string}) => void) | undefined;
  let handlerB: ((data: {toString(): string}) => void) | undefined;

  const a: StringTransport = {
    send(data: string) {
      queueMicrotask(() => handlerB?.({toString: () => data}));
    },
    onMessage(cb) {
      handlerA = cb;
    },
    ready: Promise.resolve(),
  };

  const b: StringTransport = {
    send(data: string) {
      queueMicrotask(() => handlerA?.({toString: () => data}));
    },
    onMessage(cb) {
      handlerB = cb;
    },
    ready: Promise.resolve(),
  };

  return [a, b];
}

/**
 * Creates two linked `RawTransport` instances for in-process communication.
 * Messages are structurally cloned via `structuredClone()` before delivery,
 * matching the semantics a real `postMessage` boundary would have — so tests
 * catch values that fail to survive structured clone (functions, Proxies
 * without a backing target, etc.).
 *
 * `ctx` is also cloned (minus `transfer`, which would otherwise trigger
 * transfer-list validation that the Node polyfill may not implement
 * identically to the browser). Transferables themselves are delivered as-is
 * so `instanceof ArrayBuffer` identity is preserved on the receiving end.
 */
export function createRawMemoryTransportPair(): [RawTransport, RawTransport] {
  let handlerA:
    | ((data: unknown, ctx?: TransportContext) => void | Promise<void>)
    | undefined;
  let handlerB:
    | ((data: unknown, ctx?: TransportContext) => void | Promise<void>)
    | undefined;

  const deliver = (
    handler:
      | ((data: unknown, ctx?: TransportContext) => void | Promise<void>)
      | undefined,
    data: unknown,
    ctx: TransportContext | undefined,
  ) => {
    if (!handler) return;
    const cloned = structuredClone(data);
    // Strip `transfer` from the receiver's ctx — it's a sender-only hint
    // describing which values changed ownership, not something the receiver
    // needs to (or can) act on. Other ctx keys survive so user-supplied
    // metadata flows through.
    let forwardedCtx: TransportContext | undefined;
    if (ctx) {
      forwardedCtx = {};
      for (const k of Object.keys(ctx)) {
        if (k === 'transfer') continue;
        forwardedCtx[k] = (ctx as Record<string, unknown>)[k];
      }
    }
    queueMicrotask(() => handler(cloned, forwardedCtx));
  };

  const a: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      deliver(handlerB, data, ctx);
    },
    onMessage(cb) {
      handlerA = cb;
    },
    ready: Promise.resolve(),
  };

  const b: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      deliver(handlerA, data, ctx);
    },
    onMessage(cb) {
      handlerB = cb;
    },
    ready: Promise.resolve(),
  };

  return [a, b];
}
