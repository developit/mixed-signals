import {now} from './clock.ts';
import {LatencyHistogram} from './histogram.ts';

export async function runTimedOps(
  op: () => Promise<void>,
  warmupMs: number,
  measureMs: number,
) {
  const warmupEnd = now() + warmupMs;
  while (now() < warmupEnd) {
    await op();
  }

  const histogram = new LatencyHistogram();
  const samples: number[] = [];
  const start = now();
  const end = start + measureMs;
  let ops = 0;

  while (now() < end) {
    const t0 = now();
    await op();
    const dt = now() - t0;
    histogram.record(dt);
    samples.push(dt);
    ops++;
  }

  const elapsedSec = (now() - start) / 1000;
  const mean = samples.reduce((acc, v) => acc + v, 0) / Math.max(1, samples.length);
  const variance =
    samples.reduce((acc, v) => {
      const d = v - mean;
      return acc + d * d;
    }, 0) / Math.max(1, samples.length - 1);
  const stddev = Math.sqrt(variance);
  const cv = mean > 0 ? stddev / mean : 0;

  return {
    opsPerSec: ops / elapsedSec,
    sampleCount: samples.length,
    cv,
    latency: histogram.summary(),
  };
}
