import type {BenchmarkCliOptions} from './types.ts';

function parseList<T>(value: string, map: (value: string) => T): T[] {
  return value.split(',').filter(Boolean).map(map);
}

export function parseCli(argv: string[]): BenchmarkCliOptions {
  const opts: BenchmarkCliOptions = {
    mode: 'inproc',
    profile: 'dev',
  };

  for (const arg of argv) {
    const [k, rawV] = arg.split('=');
    const v = rawV ?? '';
    if (k === '--mode') opts.mode = v as BenchmarkCliOptions['mode'];
    else if (k === '--profile') opts.profile = v as BenchmarkCliOptions['profile'];
    else if (k === '--topology') opts.topology = v as BenchmarkCliOptions['topology'];
    else if (k === '--scenario') opts.scenario = parseList(v, (x) => x);
    else if (k === '--concurrency') opts.concurrency = parseList(v, Number);
    else if (k === '--size') opts.size = Number(v);
    else if (k === '--iterations') opts.iterations = Number(v);
    else if (k === '--allow-unstable') opts.allowUnstable = true;
    else if (k === '--output') opts.output = v;
    else if (k === '--base') opts.compare = {...opts.compare, base: v} as any;
    else if (k === '--head') opts.compare = {...opts.compare, head: v} as any;
    else if (k === '--baseline-update') opts.baselineUpdate = true;
  }

  return opts;
}
