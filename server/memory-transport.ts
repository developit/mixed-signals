import type {Transport} from '../shared/protocol.ts';

/**
 * Creates two linked Transport instances for in-process communication.
 * Messages sent on one end are delivered to the other via queueMicrotask.
 */
export function createMemoryTransportPair(): [Transport, Transport] {
  let handlerA:
    | ((data: string, ctx?: any) => void | Promise<void>)
    | undefined;
  let handlerB:
    | ((data: string, ctx?: any) => void | Promise<void>)
    | undefined;

  const a: Transport = {
    send(data: string) {
      queueMicrotask(() => handlerB?.(data));
    },
    onMessage(cb) {
      handlerA = cb;
    },
    ready: Promise.resolve(),
  };

  const b: Transport = {
    send(data: string) {
      queueMicrotask(() => handlerA?.(data));
    },
    onMessage(cb) {
      handlerB = cb;
    },
    ready: Promise.resolve(),
  };

  return [a, b];
}
