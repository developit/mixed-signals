export interface Transport {
  send(data: string): void;
  onMessage(cb: (data: {toString(): string}) => void): void;
  ready?: Promise<void>;
}

export const ROOT_NOTIFICATION_METHOD = '@R';
export const SIGNAL_UPDATE_METHOD = '@S';
export const WATCH_SIGNALS_METHOD = '@W';
export const UNWATCH_SIGNALS_METHOD = '@U';

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

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Recursively converts Date, Uint8Array, and BigInt to tagged wire objects
 * before JSON.stringify (which can't handle these types natively).
 */
function toWireValue(value: unknown): unknown {
  if (value instanceof Date) return {'@D': value.getTime()};
  if (value instanceof Uint8Array) return {'@B': uint8ArrayToBase64(value)};
  if (typeof value === 'bigint') return {'@n': value.toString()};
  if (Array.isArray(value)) return value.map(toWireValue);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = toWireValue(v);
    }
    return result;
  }
  return value;
}

/**
 * JSON.parse reviver that reconstructs tagged wire objects back to
 * Date, Uint8Array, and BigInt.
 */
export function wireReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if ('@D' in obj) return new Date(obj['@D'] as number);
    if ('@B' in obj) return base64ToUint8Array(obj['@B'] as string);
    if ('@n' in obj) return BigInt(obj['@n'] as string);
  }
  return value;
}

function stringifyWireParams(params: readonly unknown[] = []): string {
  return params.map((param) => JSON.stringify(toWireValue(param))).join(',');
}

export function formatCallMessage(
  id: number,
  method: string,
  params: readonly unknown[] = [],
): string {
  return `M${id}:${method}:${stringifyWireParams(params)}`;
}

export function formatNotificationMessage(
  method: string,
  params: readonly unknown[] = [],
): string {
  return `N:${method}:${stringifyWireParams(params)}`;
}

export function formatResultMessage(id: number, result: unknown): string {
  return `R${id}:${JSON.stringify(toWireValue(result))}`;
}

export function formatErrorMessage(id: number, error: unknown): string {
  return `E${id}:${JSON.stringify(error)}`;
}
