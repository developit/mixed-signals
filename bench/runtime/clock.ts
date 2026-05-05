import {performance} from 'node:perf_hooks';

export const now = () => performance.now();

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
