import {RPC} from '../../../server/rpc.ts';
import type {Transport} from '../../../shared/protocol.ts';
import {createBrokerRoot} from './root.ts';

export interface BrokerRuntime {
  rpc: RPC;
  root: ReturnType<typeof createBrokerRoot>;
  attachBrowserClient(transport: Transport, clientId?: string): () => void;
  attachAudioUpstream(transport: Transport): () => void;
  attachVisualUpstream(transport: Transport): () => void;
}

export function createBrokerRuntime(): BrokerRuntime {
  const root = createBrokerRoot();
  const rpc = new RPC(root);

  return {
    rpc,
    root,
    attachBrowserClient(transport: Transport, clientId?: string) {
      root.session.connectedClients.value += 1;
      const dispose = rpc.addClient(transport, clientId);
      return () => {
        root.session.connectedClients.value = Math.max(
          0,
          root.session.connectedClients.value - 1,
        );
        dispose();
      };
    },
    attachAudioUpstream(transport: Transport) {
      return rpc.addUpstream(transport);
    },
    attachVisualUpstream(transport: Transport) {
      return rpc.addUpstream(transport);
    },
  };
}
