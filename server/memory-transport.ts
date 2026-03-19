import type {Transport} from '../shared/protocol.ts';

/**
 * Creates two linked Transport instances for in-process communication.
 * Messages sent on one end are delivered to the other via queueMicrotask.
 */
export function createMemoryTransportPair(): [Transport, Transport] {
  let handlerA: ((data: {toString(): string}) => void) | undefined;
  let handlerB: ((data: {toString(): string}) => void) | undefined;

  const a: Transport = {
    send(data: string) {
      queueMicrotask(() => handlerB?.({toString: () => data}));
    },
    onMessage(cb) {
      handlerA = cb;
    },
    ready: Promise.resolve(),
  };

  const b: Transport = {
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
