import {signal} from '@preact/signals-core';
import {createModel} from '../../server/model.ts';
import {generateDataset} from './dataset.ts';

export const OwnerModel = createModel((name: string, team: string) => ({
  name: signal(name),
  team: signal(team),
}));

export const ItemModel = createModel((data: ReturnType<typeof generateDataset>[number]) => ({
  id: signal(data.id),
  title: signal(data.title),
  status: signal(data.status),
  meta: signal(data.meta),
  owner: new OwnerModel(data.owner.name, data.owner.team),
}));

export const CatalogModel = createModel(() => ({
  _ringSize: 8,
  _pages: (() => {
    const ring = new Array<ReturnType<typeof generateDataset>>(8);
    for (let i = 0; i < ring.length; i++) {
      ring[i] = generateDataset(10_000 + i, 2048);
    }
    return ring;
  })(),
  async fetchPage(seed: number, size = 512) {
    const source = this._pages[seed & (this._ringSize - 1)];
    const page = new Array<any>(size);
    for (let i = 0; i < size; i++) {
      page[i] = new ItemModel(source[i]);
    }
    return page;
  },
}));

export const SessionModel = createModel((id: string) => ({
  id: signal(id),
  title: signal(id),
  tokens: signal(''),
  async noop() {},
  async mutateSmall() {
    return {ok: true, id};
  },
  async rename(next: string) {
    this.title.value = next;
    return {ok: true};
  },
  async emitTokens(tokens: string) {
    this.tokens.value += tokens;
    return this.tokens.peek().length;
  },
}));

export const BenchmarkRoot = createModel(() => {
  const sessionsArray = new Array<any>(32);
  for (let i = 0; i < 32; i++) sessionsArray[i] = new SessionModel(`s-${i}`);

  return {
    sessions: signal(sessionsArray),
    catalog: signal(new CatalogModel()),
    stream: signal(''),
    list: signal<string[]>([]),
    objectState: signal<Record<string, number>>({a: 1, b: 2}),
    async noop() {},
    async smallPayload() {
      return {ok: true, n: 1, s: 'x'};
    },
    async largePayload() {
      return generateDataset(7, 256);
    },
    appendArray(batch: string[]) {
      this.list.value = [...this.list.value, ...batch];
    },
    appendString(token: string) {
      this.stream.value = this.stream.value + token;
    },
    mergeObject(patch: Record<string, number>) {
      this.objectState.value = {...this.objectState.value, ...patch};
    },
  };
});

export function registerBenchmarkModels(rpc: {registerModel(name: string, ctor: any): void}) {
  rpc.registerModel('BenchmarkRoot', BenchmarkRoot as any);
  rpc.registerModel('SessionModel', SessionModel as any);
  rpc.registerModel('CatalogModel', CatalogModel as any);
  rpc.registerModel('ItemModel', ItemModel as any);
  rpc.registerModel('OwnerModel', OwnerModel as any);
}
