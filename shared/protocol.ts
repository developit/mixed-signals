export interface Transport {
  send(data: string): void;
  onMessage(cb: (data: {toString(): string}) => void): void;
  ready?: Promise<void>;
}

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
  return params.map((param) => JSON.stringify(param, replacer)).join(',');
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
