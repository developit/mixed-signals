export type BenchmarkMode = 'inproc' | 'workers';
export type BenchmarkTopology = 'direct' | 'forwarded';
export type BenchmarkTransport = 'microtask' | 'messageport';

export interface BenchmarkProfile {
  name: 'smoke' | 'dev' | 'full';
  warmupMs: number;
  measureMs: number;
  minSamples: number;
  cvThreshold: number;
}

export interface BenchmarkCliOptions {
  mode: BenchmarkMode;
  profile: BenchmarkProfile['name'];
  topology?: BenchmarkTopology;
  scenario?: string[];
  concurrency?: number[];
  size?: number;
  iterations?: number;
  allowUnstable?: boolean;
  output?: string;
  compare?: {base: string; head: string};
  baselineUpdate?: boolean;
}

export interface MemorySample {
  phase: 'setup' | 'warmup' | 'load' | 'quiesce' | 'sample' | 'sample-gc';
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  cpuUserUs: number;
  cpuSystemUs: number;
  v8UsedHeap: number;
}

export interface BenchmarkMetrics {
  opsPerSec: number;
  sampleCount: number;
  cv: number;
  latency: {
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  bytesPerOp?: number;
  memory?: {
    snapshots: MemorySample[];
    peakRssDeltaMb: number;
    retainedHeapDeltaMb: number;
  };
  middle?: {
    cpuUserUsPerOp: number;
    cpuSystemUsPerOp: number;
    rssDeltaBytesPerOp: number;
  };
}

export interface ScenarioCase {
  name: string;
  mode: BenchmarkMode[];
  topology: BenchmarkTopology[];
  params: Record<string, number | string>;
  run(ctx: ScenarioContext): Promise<BenchmarkMetrics>;
}

export interface ScenarioContext {
  mode: BenchmarkMode;
  topology: BenchmarkTopology;
  transport: BenchmarkTransport;
  profile: BenchmarkProfile;
  allowUnstable: boolean;
}

export interface ScenarioResult {
  scenario: string;
  mode: BenchmarkMode;
  topology: BenchmarkTopology;
  transport: BenchmarkTransport;
  params: Record<string, number | string>;
  metrics: BenchmarkMetrics;
  regression?: {pass: boolean; notes: string[]};
}

export interface BenchmarkRunResult {
  metadata: {
    timestamp: string;
    gitSha: string;
    node: string;
    platform: string;
    cpu: string;
    profile: BenchmarkProfile['name'];
  };
  results: ScenarioResult[];
}
