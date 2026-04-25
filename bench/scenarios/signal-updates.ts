import {signal} from '@preact/signals-core';
import {RPCClient} from '../../client/rpc.ts';
import {RPC} from '../../server/rpc.ts';
import {BenchmarkRoot, registerBenchmarkModels} from '../models/benchmark-models.ts';
import {registerReflectedModels} from '../models/reflected-models.ts';
import {runTimedOps} from '../runtime/metrics.ts';
import {createTransportPair} from '../runtime/transports.ts';
import type {ScenarioCase} from '../types.ts';

async function createClient(mode: 'inproc' | 'workers') {
  const rpc = new RPC();
  registerBenchmarkModels(rpc);
  rpc.expose(new BenchmarkRoot());
  const [serverTransport, clientTransport] = createTransportPair(mode);
  rpc.addClient(serverTransport, 'signals-client');
  const client = new RPCClient(clientTransport, {rpc: null as any});
  registerReflectedModels(client);
  await client.ready;
  return {rpc, client};
}

export const signalUpdatesScenario: ScenarioCase = {
  name: 'signal-updates',
  mode: ['inproc', 'workers'],
  topology: ['direct'],
  params: {fanout: 1, burst: 10},
  async run(ctx) {
    const {client} = await createClient(ctx.mode);
    client.root.list.subscribe(() => undefined);
    client.root.stream.subscribe(() => undefined);
    client.root.objectState.subscribe(() => undefined);

    let n = 0;
    const metric = await runTimedOps(async () => {
      const k = n++;
      await client.root.appendArray([`i${k}`]);
      await client.root.appendString('x');
      await client.root.mergeObject({[`k${k}`]: k});
    }, ctx.profile.warmupMs, ctx.profile.measureMs);

    const spliceSignal = signal([1, 2, 3, 4]);
    (client as any).reflection['signals'].set('splice-test', spliceSignal);
    const t0 = performance.now();
    (client as any).reflection.handleUpdate('splice-test', {start: 1, deleteCount: 1, items: [9, 8]}, 'splice');
    const spliceCostMs = performance.now() - t0;

    return {
      ...metric,
      bytesPerOp: Buffer.byteLength(JSON.stringify(client.root.objectState.value)) / Math.max(1, metric.sampleCount),
      latency: {
        ...metric.latency,
        max: Math.max(metric.latency.max, spliceCostMs),
      },
    };
  },
};
