import {RPCClient} from '../../client/rpc.ts';
import {RPC} from '../../server/rpc.ts';
import {BenchmarkRoot, registerBenchmarkModels} from '../models/benchmark-models.ts';
import {registerReflectedModels} from '../models/reflected-models.ts';
import {sleep} from '../runtime/clock.ts';
import {sampleMemory} from '../runtime/memory.ts';
import {createTransportPair} from '../runtime/transports.ts';
import type {ScenarioCase} from '../types.ts';

export const memoryLifecycleScenario: ScenarioCase = {
  name: 'memory-lifecycle',
  mode: ['inproc', 'workers'],
  topology: ['direct', 'forwarded'],
  params: {phases: 5},
  async run(ctx) {
    const rpc = new RPC();
    registerBenchmarkModels(rpc);
    rpc.expose(new BenchmarkRoot());
    const [serverTransport, clientTransport] = createTransportPair(ctx.mode);
    rpc.addClient(serverTransport, 'memory-client');

    const client = new RPCClient(clientTransport, {rpc: null as any});
    registerReflectedModels(client);
    await client.ready;

    const snapshots = [sampleMemory('setup')];
    await sleep(ctx.profile.warmupMs);
    snapshots.push(sampleMemory('warmup'));

    const loadEnd = Date.now() + ctx.profile.measureMs;
    let n = 0;
    while (Date.now() < loadEnd) {
      await client.root.catalog.value.fetchPage(n++, 256);
    }
    snapshots.push(sampleMemory('load'));

    await sleep(500);
    snapshots.push(sampleMemory('quiesce'));
    if (typeof global.gc === 'function') {
      global.gc();
      snapshots.push(sampleMemory('sample-gc'));
    }
    snapshots.push(sampleMemory('sample'));

    const start = snapshots[0];
    const peak = snapshots.reduce((a, b) => (a.rss > b.rss ? a : b));
    const end = snapshots[snapshots.length - 1];

    return {
      opsPerSec: n / (ctx.profile.measureMs / 1000),
      sampleCount: n,
      cv: 0,
      latency: {p50: 0, p95: 0, p99: 0, max: 0},
      memory: {
        snapshots,
        peakRssDeltaMb: (peak.rss - start.rss) / (1024 * 1024),
        retainedHeapDeltaMb: (end.heapUsed - start.heapUsed) / (1024 * 1024),
      },
    };
  },
};
