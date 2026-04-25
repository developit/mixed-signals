import {RPCClient} from '../../client/rpc.ts';
import {RPC} from '../../server/rpc.ts';
import {BenchmarkRoot, registerBenchmarkModels} from '../models/benchmark-models.ts';
import {registerReflectedModels} from '../models/reflected-models.ts';
import {runTimedOps} from '../runtime/metrics.ts';
import {createTransportPair} from '../runtime/transports.ts';
import type {ScenarioCase} from '../types.ts';

async function setup(topology: 'direct' | 'forwarded', mode: 'inproc' | 'workers') {
  const upstreamRpc = new RPC();
  registerBenchmarkModels(upstreamRpc);
  upstreamRpc.expose(new BenchmarkRoot());

  const [serverSide, upstreamSide] = createTransportPair(mode);
  upstreamRpc.addClient(upstreamSide, 'mid-upstream');

  const midRpc = topology === 'forwarded' ? new RPC() : upstreamRpc;
  if (topology === 'forwarded') {
    midRpc.addUpstream(serverSide);
  }

  const [serverTransport, clientTransport] = createTransportPair(mode);
  midRpc.addClient(serverTransport, 'bench-client');

  const ctx = {rpc: null as any};
  const client = new RPCClient(clientTransport, ctx);
  ctx.rpc = client;
  registerReflectedModels(client);
  await client.ready;
  return {client};
}

export const methodReflectedRoot: ScenarioCase = {
  name: 'method-reflected/root',
  mode: ['inproc', 'workers'],
  topology: ['direct', 'forwarded'],
  params: {concurrency: 1, payload: 'noop'},
  async run(ctx) {
    const {client} = await setup(ctx.topology, ctx.mode);
    const metric = await runTimedOps(async () => {
      await client.root.noop();
    }, ctx.profile.warmupMs, ctx.profile.measureMs);
    return metric;
  },
};

export const methodReflectedNested: ScenarioCase = {
  name: 'method-reflected/nested',
  mode: ['inproc', 'workers'],
  topology: ['direct', 'forwarded'],
  params: {concurrency: 1, projects: 32},
  async run(ctx) {
    const {client} = await setup(ctx.topology, ctx.mode);
    let i = 0;
    const metric = await runTimedOps(async () => {
      i = (i + 1) & 31;
      await client.root.sessions.value[i].rename(`r-${i}`);
    }, ctx.profile.warmupMs, ctx.profile.measureMs);
    return metric;
  },
};
