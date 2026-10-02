import type {Transport} from '../../../shared/protocol.ts';

export interface MessageLike {
  data: string;
}

export interface MessageEndpoint {
  postMessage(data: string): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageLike) => void,
  ): void;
}

export function createMessageEndpointTransport(
  endpoint: MessageEndpoint,
): Transport {
  return {
    send(data: string) {
      endpoint.postMessage(data);
    },
    onMessage(cb) {
      endpoint.addEventListener('message', (event) => {
        cb({toString: () => event.data});
      });
    },
    ready: Promise.resolve(),
  };
}

export function createLoopbackTransportPair(): {
  left: Transport;
  right: Transport;
} {
  let leftHandler: ((data: {toString(): string}) => void) | undefined;
  let rightHandler: ((data: {toString(): string}) => void) | undefined;

  const left: Transport = {
    send(data: string) {
      queueMicrotask(() => {
        rightHandler?.({toString: () => data});
      });
    },
    onMessage(cb) {
      leftHandler = cb;
    },
    ready: Promise.resolve(),
  };

  const right: Transport = {
    send(data: string) {
      queueMicrotask(() => {
        leftHandler?.({toString: () => data});
      });
    },
    onMessage(cb) {
      rightHandler = cb;
    },
    ready: Promise.resolve(),
  };

  return {left, right};
}
