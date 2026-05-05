import {createReflectedModel} from '../../client/model.ts';

export const ReflectedOwner = createReflectedModel(['name', 'team'], []);
export const ReflectedItem = createReflectedModel(
  ['id', 'title', 'status', 'meta', 'owner'],
  [],
);
export const ReflectedCatalog = createReflectedModel([], ['fetchPage']);
export const ReflectedSession = createReflectedModel(
  ['id', 'title', 'tokens'],
  ['noop', 'mutateSmall', 'rename', 'emitTokens'],
);
export const ReflectedBenchmarkRoot = createReflectedModel(
  ['sessions', 'catalog', 'stream', 'list', 'objectState'],
  ['noop', 'smallPayload', 'largePayload', 'appendArray', 'appendString', 'mergeObject'],
);

export function registerReflectedModels(client: {registerModel(name: string, ctor: any): void}) {
  client.registerModel('OwnerModel', ReflectedOwner);
  client.registerModel('ItemModel', ReflectedItem);
  client.registerModel('CatalogModel', ReflectedCatalog);
  client.registerModel('SessionModel', ReflectedSession);
  client.registerModel('BenchmarkRoot', ReflectedBenchmarkRoot);
}
