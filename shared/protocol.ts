/**
 * Context object carried alongside every wire message. Defaults to the
 * postMessage options shape so a RawTransport can pass it through directly:
 *
 *   Worker.prototype.postMessage(message, options?)   // options = {transfer?}
 *   MessagePort.prototype.postMessage(message, options?)
 *   DedicatedWorkerGlobalScope.prototype.postMessage(message, options?)
 *
 * Extra keys on `ctx` are ignored by the DOM per spec. Consumers may extend
 * the interface with their own metadata (auth, correlation ids, etc.) and a
 * well-behaved transport will propagate it end to end.
 */
export interface TransportContext {
  transfer?: Transferable[];
  [key: string]: unknown;
}

type BaseTransport<Outgoing, Incoming, Ctx> = {
  send(data: Outgoing, ctx?: Ctx): void;
  onMessage(cb: (data: Incoming, ctx?: Ctx) => void | Promise<void>): void;
  ready?: Promise<void>;
};

/**
 * Wire framing is the compact string protocol (`M1:method:payload`, etc.).
 * Every payload passes through `JSON.stringify` / `JSON.parse`. Use for
 * byte-stream transports (WebSocket, stdio, fetch/SSE).
 */
export interface StringTransport<Ctx = TransportContext>
  extends BaseTransport<string, {toString(): string}, Ctx> {
  mode?: 'string' | undefined;
}

/**
 * Wire "framing" is a structured object the transport delivers as-is. Use
 * for `postMessage`-family transports (Worker, MessagePort, DedicatedWorker,
 * BroadcastChannel-likes). Skips JSON stringify/parse entirely; the
 * serializer populates `ctx.transfer` so ArrayBuffer / MessagePort / etc.
 * can be transferred rather than copied.
 */
export interface RawTransport<Ctx = TransportContext>
  extends BaseTransport<unknown, unknown, Ctx> {
  mode: 'raw';
}

export type Transport<Ctx = TransportContext> =
  | StringTransport<Ctx>
  | RawTransport<Ctx>;

export const ROOT_NOTIFICATION_METHOD = '@R';
export const SIGNAL_UPDATE_METHOD = '@S';
export const WATCH_SIGNALS_METHOD = '@W';
export const UNWATCH_SIGNALS_METHOD = '@U';
/** Client → server: drop these handle ids (coalesced). "D" as in dereference. */
export const RELEASE_HANDLES_METHOD = '@D';
/** Server → client: a previously-pending promise handle has resolved. */
export const PROMISE_RESOLVE_METHOD = '@P';
/** Server → client: a previously-pending promise handle has rejected. */
export const PROMISE_REJECT_METHOD = '@E';
/**
 * Every structured reference on the wire uses this field name.
 * The first character of the id is the kind: s=signal, o=object,
 * f=function, p=promise. See shared/brand.ts.
 */
export const HANDLE_MARKER = '@H';
/**
 * Class reference. On first emission of a class to a peer, the value is a
 * string `"<classId>#<className>"` (or `"<classId>"` for anonymous classes).
 * On subsequent emissions it is the numeric class id. The client normalizes
 * with `String(c)` and looks the class up in its per-connection registry.
 *
 * Present only on wire markers for *cached-class instances* (objects whose
 * ctor is not `Object`). Ad-hoc objects (even ones with methods) omit `c`.
 */
export const CLASS_FIELD = 'c';
/**
 * Properties prelude for a new class: a comma-separated list of property
 * names in the order they appear in the parallel `d` array. Property names
 * on cached classes must not contain `,`.
 */
export const PROPS_FIELD = 'p';
/**
 * Data payload.
 *   - Cached-class instance: positional array, ordered to match `p`.
 *   - Ad-hoc object (no `c`): keyed object `{key: value}`.
 */
export const DATA_FIELD = 'd';
/** Signal value (for kind=s, initial inline value). */
export const SIGNAL_VALUE_FIELD = 'v';

/**
 * Internal wire message. The codec layer converts to/from StringTransport's
 * framing. RawTransport sends / receives this object directly.
 */
export type WireMessage =
  | {type: 'call'; id: number; method: string; params: unknown[]}
  | {type: 'notification'; method: string; params: unknown[]}
  | {type: 'result'; id: number; value: unknown}
  | {type: 'error'; id: number; value: unknown};

type ParsedCallMessage = {
  type: 'call';
  id: number;
  method: string;
  payload: string;
};

type ParsedNotificationMessage = {
  type: 'notification';
  method: string;
  payload: string;
};

type ParsedResultMessage = {
  type: 'result';
  id: number;
  payload: string;
};

type ParsedErrorMessage = {
  type: 'error';
  id: number;
  payload: string;
};

export type ParsedWireMessage =
  | ParsedCallMessage
  | ParsedNotificationMessage
  | ParsedResultMessage
  | ParsedErrorMessage;

function parseMessageId(value: string): number | undefined {
  if (value === '') return undefined;

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function parseWireMessage(message: string): ParsedWireMessage | null {
  if (message.length < 2) return null;

  const type = message[0];

  if (type === 'R' || type === 'E') {
    const separatorIndex = message.indexOf(':');
    if (separatorIndex === -1) return null;

    const id = parseMessageId(message.slice(1, separatorIndex));
    if (id === undefined) return null;

    return {
      type: type === 'R' ? 'result' : 'error',
      id,
      payload: message.slice(separatorIndex + 1),
    };
  }

  if (type !== 'M' && type !== 'N') return null;

  const methodSeparatorIndex = message.indexOf(':', 1);
  if (methodSeparatorIndex === -1) return null;

  const payloadSeparatorIndex = message.indexOf(':', methodSeparatorIndex + 1);
  if (payloadSeparatorIndex === -1) return null;

  const id = message.slice(1, methodSeparatorIndex);
  const method = message.slice(methodSeparatorIndex + 1, payloadSeparatorIndex);
  const payload = message.slice(payloadSeparatorIndex + 1);

  if (!method) return null;

  if (type === 'M') {
    const parsedId = parseMessageId(id);
    if (parsedId === undefined) return null;

    return {
      type: 'call',
      id: parsedId,
      method,
      payload,
    };
  }

  if (id !== '') return null;

  return {
    type: 'notification',
    method,
    payload,
  };
}

export function parseWireParams<T = unknown[]>(
  payload: string,
  reviver?: (key: string, value: unknown) => unknown,
): T {
  return JSON.parse(payload ? `[${payload}]` : '[]', reviver) as T;
}

export function parseWireValue<T = unknown>(
  payload: string,
  reviver?: (key: string, value: unknown) => unknown,
): T {
  return JSON.parse(payload, reviver) as T;
}

function stringifyWireParams(
  params: readonly unknown[] = [],
  replacer?: (this: any, key: string, value: any) => any,
): string {
  if (params.length === 0) return '';
  return JSON.stringify(params, replacer).slice(1, -1);
}

export function formatCallMessage(
  id: number,
  method: string,
  params: readonly unknown[] = [],
  replacer?: (this: any, key: string, value: any) => any,
): string {
  return `M${id}:${method}:${stringifyWireParams(params, replacer)}`;
}

export function formatNotificationMessage(
  method: string,
  params: readonly unknown[] = [],
  replacer?: (this: any, key: string, value: any) => any,
): string {
  return `N:${method}:${stringifyWireParams(params, replacer)}`;
}

export function formatResultMessage(
  id: number,
  result: unknown,
  replacer?: (this: any, key: string, value: any) => any,
): string {
  return `R${id}:${JSON.stringify(result, replacer)}`;
}

export function formatErrorMessage(
  id: number,
  error: unknown,
  replacer?: (this: any, key: string, value: any) => any,
): string {
  return `E${id}:${JSON.stringify(error, replacer)}`;
}
