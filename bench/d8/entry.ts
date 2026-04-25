import {RPCClient} from '../../client/rpc.ts';
import {RPC} from '../../server/rpc.ts';
import {BenchmarkRoot, registerBenchmarkModels} from '../models/benchmark-models.ts';
import {registerReflectedModels} from '../models/reflected-models.ts';
import {createMemoryTransportPair} from '../../server/memory-transport.ts';

type Profile = 'smoke' | 'full';

if (!(globalThis as any).queueMicrotask) {
  (globalThis as any).queueMicrotask = (cb: () => void) =>
    Promise.resolve().then(cb);
}

const PROFILES: Record<Profile, {warmupMs: number; measureMs: number}> = {
  smoke: {warmupMs: 1200, measureMs: 2500},
  full: {warmupMs: 2500, measureMs: 10000},
};

const perfNow = () =>
  typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();

async function setupClient() {
  const rpc = new RPC();
  registerBenchmarkModels(rpc);
  rpc.expose(new BenchmarkRoot());
  const [serverTransport, clientTransport] = createMemoryTransportPair();
  rpc.addClient(serverTransport, 'd8-client');

  const ctx = {rpc: null as any};
  const client = new RPCClient(clientTransport, ctx);
  ctx.rpc = client;
  registerReflectedModels(client);
  await client.ready;
  return client;
}

async function runTimed(
  op: () => Promise<void>,
  warmupMs: number,
  measureMs: number,
) {
  const warmupUntil = perfNow() + warmupMs;
  while (perfNow() < warmupUntil) await op();

  const samples: number[] = [];
  let ops = 0;
  const start = perfNow();
  const measureUntil = start + measureMs;
  while (perfNow() < measureUntil) {
    const t0 = perfNow();
    await op();
    samples.push(perfNow() - t0);
    ops++;
  }

  samples.sort((a, b) => a - b);
  const p = (n: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * n))] ?? 0;
  const mean = samples.reduce((acc, v) => acc + v, 0) / Math.max(1, samples.length);
  const variance =
    samples.reduce((acc, v) => {
      const d = v - mean;
      return acc + d * d;
    }, 0) / Math.max(1, samples.length - 1);

  return {
    opsPerSec: ops / ((perfNow() - start) / 1000),
    sampleCount: samples.length,
    cv: mean > 0 ? Math.sqrt(variance) / mean : 0,
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    max: samples[samples.length - 1] ?? 0,
  };
}

async function run(profile: Profile) {
  const cfg = PROFILES[profile];

  const rootClient = await setupClient();
  const methodRoot = await runTimed(
    () => rootClient.root.noop(),
    cfg.warmupMs,
    cfg.measureMs,
  );

  const nestedClient = await setupClient();
  let i = 0;
  const methodNested = await runTimed(async () => {
    i = (i + 1) & 31;
    await nestedClient.root.sessions.value[i].rename(`d8-${i}`);
  }, cfg.warmupMs, cfg.measureMs);

  const largeGraphClient = await setupClient();
  let seed = 1;
  const largeGraph = await runTimed(async () => {
    const page = await largeGraphClient.root.catalog.value.fetchPage(seed++, 512);
    if (page.length !== 512) throw new Error('invalid page size');
  }, cfg.warmupMs, cfg.measureMs);

  return {
    engine: 'd8',
    profile,
    mode: 'd8-inproc',
    timestamp: new Date().toISOString(),
    results: [
      {scenario: 'method-reflected/root', ...methodRoot},
      {scenario: 'method-reflected/nested', ...methodNested},
      {scenario: 'initial-large-graph', ...largeGraph},
    ],
  };
}

function parseProfile(): Profile {
  const profile = (globalThis as any).__BENCH_PROFILE;
  return profile === 'smoke' ? 'smoke' : 'full';
}

run(parseProfile())
  .then((result) => {
    (globalThis as any).print(JSON.stringify(result));
  })
  .catch((error) => {
    (globalThis as any).print(`ERROR:${error?.stack || error}`);
  });
