import {
  computed,
  createModel,
  type ModelConstructor,
  type ReadonlySignal,
  Signal,
  signal,
} from '@preact/signals-core';
import type {WireContext} from './reflection.ts';

type AnyFunction = (...args: any[]) => any;

type ReflectedMethod<T extends AnyFunction> = (
  ...args: Parameters<T>
) => Promise<Reflected<Awaited<ReturnType<T>>>>;

type ReflectedObject<T extends object> = {
  readonly [Key in keyof T]: Reflected<T[Key]>;
};

type ReflectedSignalValue<T> = T extends AnyFunction
  ? ReflectedMethod<T>
  : T extends ReadonlySignal<infer Value>
    ? ReadonlySignal<ReflectedSignalValue<Value>>
    : T extends readonly (infer Item)[]
      ? ReflectedSignalValue<Item>[]
      : T extends object
        ? ReflectedObject<T>
        : T;

/**
 * Client-side shape for a server value after mixed-signals reflection.
 * Signals become read-only client signals and methods become async RPC calls.
 */
export type Reflected<T> =
  T extends ReadonlySignal<infer Value>
    ? ReadonlySignal<ReflectedSignalValue<Value>>
    : T extends AnyFunction
      ? ReflectedMethod<T>
      : T extends readonly (infer Item)[]
        ? Reflected<Item>[]
        : T extends object
          ? ReflectedObject<T>
          : T;

/** Client-side facade shape for a reflected server model instance. */
export type ReflectedModel<T extends object = Record<string, unknown>> =
  ReflectedObject<T> & {
    /** The server wire identity when the model does not expose its own `id` signal. */
    readonly id: ReadonlySignal<string>;
  };

declare const reflectedRootBrand: unique symbol;

/**
 * Declaration-merging hook for projects that want a typed `RPCClient.root`
 * without passing a generic at every construction site.
 */
export interface ReflectedRoot {
  /** @internal */
  readonly [reflectedRootBrand]?: never;
}

type RegisteredReflectedRoot = Omit<ReflectedRoot, typeof reflectedRootBrand>;

/** @internal */
export type DefaultReflectedRoot = keyof RegisteredReflectedRoot extends never
  ? any
  : RegisteredReflectedRoot;

/** @internal */
export type ReflectedModelWireData = Record<string, any> & {
  '@M'?: string;
  '@wireId'?: string;
};

/** @internal */
export type ReflectedModelConstructor<T = any> = new (
  ctx: WireContext,
  data: ReflectedModelWireData,
) => T;

/** @internal */
export interface ReflectedModelOptions {
  signalProps?: readonly string[];
  methods?: readonly string[];
  typeName?: string;
}

/** @internal */
export const REFRESH_REFLECTED_MODEL = Symbol('mixed-signals.refreshModel');

/** @internal */
export const GET_REFLECTED_MODEL_SIGNALS = Symbol(
  'mixed-signals.getModelSignals',
);

/** @internal */
export interface RefreshableReflectedModel {
  [REFRESH_REFLECTED_MODEL]?(data: ReflectedModelWireData): void;
  [GET_REFLECTED_MODEL_SIGNALS]?(): Signal<any>[];
}

type ReflectedModelState = {
  ctx: WireContext;
  wireId: string;
  fallbackId: Signal<string>;
  signalSources: Map<string, Signal<Signal<any>>>;
  methods: Map<string, AnyFunction>;
};

const RESERVED_METHOD_PROPERTIES = new Set([
  'then',
  'catch',
  'finally',
  'toJSON',
  'toString',
  'valueOf',
  'inspect',
  'constructor',
  'prototype',
  '__proto__',
]);

function parseWireId(data: ReflectedModelWireData): string {
  if (data['@wireId'] !== undefined) return String(data['@wireId']);

  const marker = data['@M'];
  if (typeof marker === 'string') {
    const hashIdx = marker.lastIndexOf('#');
    return hashIdx === -1 ? marker : marker.slice(hashIdx + 1);
  }

  return '';
}

function canProxyMethod(prop: string): boolean {
  return prop !== '' && !RESERVED_METHOD_PROPERTIES.has(prop);
}

function defineValue(target: any, prop: string, value: any) {
  Object.defineProperty(target, prop, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function createMethodProxy(state: ReflectedModelState, method: string) {
  let fn = state.methods.get(method);
  if (!fn) {
    fn = (...args: any[]) =>
      state.ctx.rpc.call(`${state.wireId}#${method}`, args);
    Object.defineProperty(fn, 'name', {
      value: method,
      configurable: true,
    });
    state.methods.set(method, fn);
  }
  return fn;
}

/** @internal */
export function createReflectedModelFacade<T = any>(
  ctx: WireContext,
  data: ReflectedModelWireData,
  options: ReflectedModelOptions = {},
): T {
  const wireId = parseWireId(data);
  const target: any = {};
  const state: ReflectedModelState = {
    ctx,
    wireId,
    fallbackId: signal(wireId),
    signalSources: new Map(),
    methods: new Map(),
  };

  defineValue(target, 'id', state.fallbackId);

  const setSignal = (prop: string, nextSignal: Signal<any>) => {
    const source = state.signalSources.get(prop);
    if (source) {
      source.value = ctx.rpc.syncSignalIdentity(source.peek(), nextSignal);
    } else {
      const createdSource = signal(nextSignal);
      state.signalSources.set(prop, createdSource);
      defineValue(
        target,
        prop,
        computed(() => createdSource.value.value),
      );
    }
  };

  const refresh = (nextData: ReflectedModelWireData) => {
    const nextWireId = parseWireId(nextData);
    if (state.wireId !== nextWireId) {
      state.wireId = nextWireId;
      if (!state.signalSources.has('id')) state.fallbackId.value = nextWireId;
    }

    const entries = options.signalProps
      ? options.signalProps.map((prop) => [prop, nextData[prop]] as const)
      : Object.entries(nextData);
    for (const [prop, value] of entries) {
      if (value instanceof Signal) setSignal(prop, value);
    }
  };

  refresh(data);

  for (const method of options.methods ?? []) {
    if (canProxyMethod(method) && !Object.hasOwn(target, method)) {
      defineValue(target, method, createMethodProxy(state, method));
    }
  }

  return new Proxy(target, {
    get(target, prop, receiver) {
      if (prop === REFRESH_REFLECTED_MODEL) return refresh;
      if (prop === GET_REFLECTED_MODEL_SIGNALS) {
        return () =>
          Array.from(state.signalSources.values(), (source) => source.peek());
      }
      if (prop === Symbol.toStringTag)
        return options.typeName ?? 'ReflectedModel';
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (!canProxyMethod(prop)) return undefined;
      return createMethodProxy(state, prop);
    },
  }) as T;
}

/**
 * @deprecated Reflected model constructors are no longer required on the client.
 * `RPCClient` now builds proxy facades directly from the server-sent model
 * definition. This helper remains for older code and for custom constructors.
 */
export function createReflectedModel<T = any>(
  signalProps?: readonly string[],
  methods: readonly string[] = [],
): ModelConstructor<T, [ctx: any, data: any]> {
  return createModel<T, [ctx: any, data: any]>(
    (ctx, data) =>
      createReflectedModelFacade<T>(ctx as WireContext, data, {
        signalProps,
        methods,
      }) as any,
  );
}
