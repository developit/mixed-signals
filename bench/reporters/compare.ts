import fs from 'node:fs/promises';
import {REGRESSION_THRESHOLDS} from '../config.ts';
import type {BenchmarkRunResult} from '../types.ts';

function keyOf(s: {scenario: string; mode: string; topology: string}) {
  return `${s.scenario}|${s.mode}|${s.topology}`;
}

export async function compareReports(basePath: string, headPath: string) {
  const [base, head] = await Promise.all([
    fs.readFile(basePath, 'utf8'),
    fs.readFile(headPath, 'utf8'),
  ]);
  const baseJson = JSON.parse(base) as BenchmarkRunResult;
  const headJson = JSON.parse(head) as BenchmarkRunResult;
  const baseMap = new Map(baseJson.results.map((r) => [keyOf(r), r]));

  const notes: string[] = [];
  let pass = true;
  for (const h of headJson.results) {
    const b = baseMap.get(keyOf(h));
    if (!b) continue;

    const latencyPct = ((h.metrics.latency.p95 - b.metrics.latency.p95) / Math.max(0.0001, b.metrics.latency.p95)) * 100;
    const throughputPct = ((h.metrics.opsPerSec - b.metrics.opsPerSec) / Math.max(0.0001, b.metrics.opsPerSec)) * 100;
    if (latencyPct > REGRESSION_THRESHOLDS.latencyPct) {
      pass = false;
      notes.push(`${h.scenario}: latency regression ${latencyPct.toFixed(2)}%`);
    }
    if (throughputPct < REGRESSION_THRESHOLDS.throughputPct) {
      pass = false;
      notes.push(`${h.scenario}: throughput regression ${throughputPct.toFixed(2)}%`);
    }
  }

  return {pass, notes};
}
