import {RPCClient} from '../../../client/rpc.ts';
import type {Transport} from '../../../shared/protocol.ts';
import {
  AudienceModel,
  BurstModel,
  ClusterModel,
  DebugHubModel,
  MotifModel,
  OrchestraModel,
  PerformerModel,
  SectionModel,
  SessionModel,
  VisualSceneModel,
} from './models.ts';

export function createOrchestraClient(transport: Transport) {
  const ctx = {rpc: null as unknown as RPCClient};
  const rpc = new RPCClient(transport, ctx);
  ctx.rpc = rpc;

  rpc.registerModel('Performer', PerformerModel);
  rpc.registerModel('Section', SectionModel);
  rpc.registerModel('Motif', MotifModel);
  rpc.registerModel('Orchestra', OrchestraModel);
  rpc.registerModel('Cluster', ClusterModel);
  rpc.registerModel('Burst', BurstModel);
  rpc.registerModel('VisualScene', VisualSceneModel);
  rpc.registerModel('Session', SessionModel);
  rpc.registerModel('Audience', AudienceModel);
  rpc.registerModel('DebugHub', DebugHubModel);

  return rpc;
}
