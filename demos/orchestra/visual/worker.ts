import {RPC} from '../../../server/rpc.ts';
import {
  createMessageEndpointTransport,
  type MessageEndpoint,
} from '../shared/transports.ts';
import {Burst, Cluster, VisualScene} from './models.ts';
import {createVisualRoot} from './root.ts';

export function createVisualWorkerRPC(endpoint: MessageEndpoint) {
  const rpc = new RPC(createVisualRoot());
  rpc.registerModel('VisualScene', VisualScene);
  rpc.registerModel('Cluster', Cluster);
  rpc.registerModel('Burst', Burst);
  rpc.addClient(
    createMessageEndpointTransport(endpoint),
    'visual-worker-client',
  );
  return rpc;
}
