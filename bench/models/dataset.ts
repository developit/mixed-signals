import {mulberry32} from './seeds.ts';

export interface DatasetItem {
  id: string;
  title: string;
  status: 'active' | 'idle';
  meta: {score: number; tag: string};
  owner: {name: string; team: string};
}

export function generateDataset(seed: number, size: number): DatasetItem[] {
  const rand = mulberry32(seed);
  const out = new Array<DatasetItem>(size);
  for (let i = 0; i < size; i++) {
    const n = Math.floor(rand() * 100000);
    out[i] = {
      id: `item-${seed}-${i}`,
      title: `Item ${n}`,
      status: i % 2 === 0 ? 'active' : 'idle',
      meta: {score: n % 101, tag: `t${n % 16}`},
      owner: {name: `user-${n % 1000}`, team: `team-${n % 32}`},
    };
  }
  return out;
}
