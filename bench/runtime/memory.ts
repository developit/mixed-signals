import v8 from 'node:v8';
import type {MemorySample} from '../types.ts';

export function sampleMemory(phase: MemorySample['phase']): MemorySample {
  const m = process.memoryUsage();
  const r = process.resourceUsage();
  const h = v8.getHeapStatistics();
  return {
    phase,
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
    cpuUserUs: r.userCPUTime,
    cpuSystemUs: r.systemCPUTime,
    v8UsedHeap: h.used_heap_size,
  };
}
