import {RPCClient} from '../../client/rpc.ts';
import {RPC} from '../../server/rpc.ts';
import {BenchmarkRoot, registerBenchmarkModels} from '../models/benchmark-models.ts';
import {registerReflectedModels} from '../models/reflected-models.ts';
import {sampleMemory} from '../runtime/memory.ts';
import {runTimedOps} from '../runtime/metrics.ts';
import {createTransportPair} from '../runtime/transports.ts';
import type {ScenarioCase} from '../types.ts';

export const initialLargeGraphScenario: ScenarioCase = {
  name: 'initial-large-graph',
  mode: ['inproc', 'workers'],
  topology: ['direct', 'forwarded'],
  params: {size: 512},
  async run(ctx) {
    const upstreamRpc = new RPC();
    registerBenchmarkModels(upstreamRpc);
    upstreamRpc.expose(new BenchmarkRoot());

    const [serverTransport, clientTransport] = createTransportPair(ctx.mode);
    upstreamRpc.addClient(serverTransport, 'large-client');

    const rpcClient = new RPCClient(clientTransport, {rpc: null as any});
    registerReflectedModels(rpcClient);
    await rpcClient.ready;

    const snapshots = [sampleMemory('setup')];
    let seed = 1;
    const metric = await runTimedOps(async () => {
      const page = await rpcClient.root.catalog.value.fetchPage(seed++, 512);
      if (page.length !== 512) throw new Error('invalid fixed-size page');
    }, ctx.profile.warmupMs, ctx.profile.measureMs);
    snapshots.push(sampleMemory('sample'));

    const setup = snapshots[0];
    const sample = snapshots[1];

    return {
      ...metric,
      memory: {
        snapshots,
        peakRssDeltaMb: (sample.rss - setup.rss) / (1024 * 1024),
        retainedHeapDeltaMb: (sample.heapUsed - setup.heapUsed) / (1024 * 1024),
      },
    };
  },
};
