import type {BenchmarkProfile} from './types.ts';

export const PROFILES: Record<BenchmarkProfile['name'], BenchmarkProfile> = {
  smoke: {
    name: 'smoke',
    warmupMs: 2000,
    measureMs: 2500,
    minSamples: 50,
    cvThreshold: 0.15,
  },
  dev: {
    name: 'dev',
    warmupMs: 2200,
    measureMs: 8000,
    minSamples: 200,
    cvThreshold: 0.08,
  },
  full: {
    name: 'full',
    warmupMs: 2500,
    measureMs: 10000,
    minSamples: 300,
    cvThreshold: 0.08,
  },
};

export const REGRESSION_THRESHOLDS = {
  latencyPct: 10,
  throughputPct: -8,
  retainedMb: 16,
  retainedPct: 20,
};
