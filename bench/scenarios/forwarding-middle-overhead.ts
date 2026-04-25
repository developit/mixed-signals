import {RPCClient} from '../../client/rpc.ts';
import {RPC} from '../../server/rpc.ts';
import {BenchmarkRoot, registerBenchmarkModels} from '../models/benchmark-models.ts';
import {registerReflectedModels} from '../models/reflected-models.ts';
import {sampleMemory} from '../runtime/memory.ts';
import {runTimedOps} from '../runtime/metrics.ts';
import {createTransportPair} from '../runtime/transports.ts';
import type {BenchmarkMetrics, ScenarioCase} from '../types.ts';

async function runPath(mode: 'inproc' | 'workers', forwarded: boolean): Promise<BenchmarkMetrics> {
  const upstream = new RPC();
  registerBenchmarkModels(upstream);
  upstream.expose(new BenchmarkRoot());

  let edgeRpc = upstream;
  const before = sampleMemory('setup');
  const cpu0 = process.resourceUsage();

  if (forwarded) {
    const middle = new RPC();
    const [mServer, mUpstream] = createTransportPair(mode);
    upstream.addClient(mUpstream, 'upstream-link');
    middle.addUpstream(mServer);
    edgeRpc = middle;
  }

  const [serverTransport, clientTransport] = createTransportPair(mode);
  edgeRpc.addClient(serverTransport, 'bench-client');

  const client = new RPCClient(clientTransport, {rpc: null as any});
  registerReflectedModels(client);
  await client.ready;

  const metric = await runTimedOps(async () => {
    await client.root.noop();
  }, 1200, 2800);

  const cpu1 = process.resourceUsage();
  const after = sampleMemory('sample');

  return {
    ...metric,
    middle: {
      cpuUserUsPerOp: (cpu1.userCPUTime - cpu0.userCPUTime) / Math.max(1, metric.sampleCount),
      cpuSystemUsPerOp: (cpu1.systemCPUTime - cpu0.systemCPUTime) / Math.max(1, metric.sampleCount),
      rssDeltaBytesPerOp: (after.rss - before.rss) / Math.max(1, metric.sampleCount),
    },
  };
}

export const forwardingMiddleOverheadScenario: ScenarioCase = {
  name: 'forwarding-middle-overhead',
  mode: ['inproc', 'workers'],
  topology: ['forwarded'],
  params: {paired: 1},
  async run(ctx) {
    const direct = await runPath(ctx.mode, false);
    const forwarded = await runPath(ctx.mode, true);
    return {
      ...forwarded,
      opsPerSec: forwarded.opsPerSec,
      bytesPerOp: ((direct.opsPerSec - forwarded.opsPerSec) / Math.max(1, direct.opsPerSec)) * 100,
    };
  },
};
