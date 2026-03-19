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

function stringifyWireParams(params: readonly unknown[] = []): string {
  return params.map((param) => JSON.stringify(param)).join(',');
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
  return `R${id}:${JSON.stringify(result)}`;
}

export function formatErrorMessage(id: number, error: unknown): string {
  return `E${id}:${JSON.stringify(error)}`;
}
