import type {BenchmarkRunResult} from '../types.ts';

export function printConsoleReport(result: BenchmarkRunResult) {
  console.log(`\nBenchmark @ ${result.metadata.timestamp} (${result.metadata.gitSha})`);
  for (const entry of result.results) {
    console.log(
      [
        entry.scenario,
        `${entry.mode}/${entry.topology}`,
        `${entry.metrics.opsPerSec.toFixed(1)} ops/s`,
        `p95=${entry.metrics.latency.p95.toFixed(3)}ms`,
        `cv=${(entry.metrics.cv * 100).toFixed(1)}%`,
      ].join(' | '),
    );
  }
}
