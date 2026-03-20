import {RPC} from '../../../server/rpc.ts';
import {
  createMessageEndpointTransport,
  type MessageEndpoint,
} from '../shared/transports.ts';
import {Motif, Orchestra, Performer, Section} from './models.ts';
import {createAudioRoot} from './root.ts';

export function createAudioWorkerRPC(endpoint: MessageEndpoint) {
  const rpc = new RPC(createAudioRoot());
  rpc.registerModel('Orchestra', Orchestra);
  rpc.registerModel('Section', Section);
  rpc.registerModel('Performer', Performer);
  rpc.registerModel('Motif', Motif);
  rpc.addClient(
    createMessageEndpointTransport(endpoint),
    'audio-worker-client',
  );
  return rpc;
}
