import fs from 'node:fs/promises';
import path from 'node:path';
import type {BenchmarkRunResult} from '../types.ts';

export async function writeJsonReport(result: BenchmarkRunResult, file?: string) {
  const name = file ?? `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const out = path.resolve('bench/results', name);
  await fs.mkdir(path.dirname(out), {recursive: true});
  await fs.writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  const latest = path.resolve('bench/results/latest.json');
  await fs.writeFile(latest, `${JSON.stringify(result, null, 2)}\n`);
  return out;
}
