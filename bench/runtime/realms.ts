import {RPC} from '../../server/rpc.ts';
import {RPCClient} from '../../client/rpc.ts';
import type {Transport} from '../../shared/protocol.ts';

export function createServerRealm(transport: Transport, root: any, register: (rpc: RPC) => void) {
  const rpc = new RPC();
  register(rpc);
  rpc.expose(root);
  const dispose = rpc.addClient(transport, 'bench-client');
  return {rpc, dispose};
}

export function createClientRealm(transport: Transport, register: (client: RPCClient) => void) {
  const ctx = {rpc: null as any};
  const client = new RPCClient(transport, ctx);
  ctx.rpc = client;
  register(client);
  return client;
}
