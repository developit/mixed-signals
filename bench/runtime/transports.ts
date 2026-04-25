import {MessageChannel} from 'node:worker_threads';
import {createMemoryTransportPair} from '../../server/memory-transport.ts';
import type {Transport} from '../../shared/protocol.ts';
import type {BenchmarkMode} from '../types.ts';

export function createTransportPair(mode: BenchmarkMode): [Transport, Transport] {
  if (mode === 'inproc') return createMemoryTransportPair();

  const channel = new MessageChannel();
  const a: Transport = {
    send(data) {
      channel.port1.postMessage(data);
    },
    onMessage(cb) {
      channel.port1.on('message', (msg) => cb({toString: () => String(msg)}));
    },
    ready: Promise.resolve(),
  };

  const b: Transport = {
    send(data) {
      channel.port2.postMessage(data);
    },
    onMessage(cb) {
      channel.port2.on('message', (msg) => cb({toString: () => String(msg)}));
    },
    ready: Promise.resolve(),
  };

  return [a, b];
}
