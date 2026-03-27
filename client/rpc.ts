import {
  formatCallMessage,
  formatRawCallMessage,
  formatRawNotificationMessage,
  formatNotificationMessage,
  parseWireMessage,
  parseWireParams,
  parseWireValue,
  type RawWireMessage,
  ROOT_NOTIFICATION_METHOD,
  SIGNAL_UPDATE_METHOD,
  type RawTransport,
  type StringTransport,
  type Transport,
} from '../shared/protocol.ts';
import {ClientReflection} from './reflection.ts';

export class RPCClient {
  private transport: Transport;
  private mode: 'string' | 'raw';
  private nextId = 1;
  private pending = new Map<
    number,
    {resolve: (v: any) => void; reject: (e: any) => void}
  >();
  private notificationListeners = new Set<
    (method: string, params: any[]) => void
  >();
  /** @internal */
  reflection: ClientReflection;
  private transportReady: Promise<void> | undefined;
  root: any = undefined;
  ready: Promise<void>;
  private _resolveReady!: () => void;

  constructor(transport: Transport, ctx?: any) {
    this.transport = transport;
    this.mode = transport.mode === 'raw' ? 'raw' : 'string';
    this.transportReady = transport.ready;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.reflection = new ClientReflection(this, ctx);

    transport.onMessage((data, messageCtx) => {
      const message = this.readIncomingMessage(data, messageCtx);
      if (!message) return;

      if (message.type === 'result' || message.type === 'error') {
        const parsed = this.reflection.deserialize(message.value);
        const pending = this.pending.get(message.id);
        if (!pending) return;

        this.pending.delete(message.id);

        if (message.type === 'result') {
          pending.resolve(parsed);
          return;
        }

        pending.reject(new Error((parsed as {message?: string}).message));
        return;
      }

      if (message.type === 'call') return;

      const params = this.reflection.deserialize(message.params) as any[];
      this.handleNotification(message.method, params);
    });
  }

  registerModel(typeName: string, ctor: any) {
    this.reflection.registerModel(typeName, ctor);
  }

  async call(method: string, params?: any): Promise<any> {
    if (this.transportReady) await this.transportReady;
    return new Promise((resolve, reject) => {
      this.sendCall(method, params, resolve, reject);
    });
  }

  notify(method: string, params?: any[]) {
    this.sendWireMessage(
      this.mode === 'raw'
        ? formatRawNotificationMessage(method, params)
        : formatNotificationMessage(method, params),
    );
  }

  private sendCall(
    method: string,
    params: any,
    resolve: (v: any) => void,
    reject: (e: any) => void,
  ) {
    const id = this.nextId++;
    this.pending.set(id, {resolve, reject});
    this.sendWireMessage(
      this.mode === 'raw'
        ? formatRawCallMessage(id, method, params || [])
        : formatCallMessage(id, method, params || []),
    );
  }

  onNotification(cb: (method: string, params: any[]) => void): () => void {
    this.notificationListeners.add(cb);
    return () => {
      this.notificationListeners.delete(cb);
    };
  }

  private handleNotification(method: string, params: any[]) {
    if (method === ROOT_NOTIFICATION_METHOD) {
      this.root = params[0];
      this._resolveReady();
    } else if (method === SIGNAL_UPDATE_METHOD) {
      const [id, value, mode] = params;
      this.reflection.handleUpdate(id, value, mode);
    } else {
      for (const listener of this.notificationListeners) {
        listener(method, params);
      }
    }
  }

  private sendWireMessage(message: string | RawWireMessage) {
    const ctx = {};
    if (this.mode === 'raw') {
      const output = this.transport.encode
        ? this.transport.encode(message, ctx as never)
        : message;
      (this.transport as RawTransport).send(output, ctx as never);
      return;
    }

    const output = this.transport.encode
      ? this.transport.encode(message, ctx as never)
      : (typeof message === 'string' ? message : JSON.stringify(message));
    (this.transport as StringTransport).send(String(output), ctx as never);
  }

  private readIncomingMessage(
    data: unknown,
    context: unknown,
  ):
    | {type: 'call'; id: number; method: string; params: any[]}
    | {type: 'notification'; method: string; params: any[]}
    | {type: 'result'; id: number; value: any}
    | {type: 'error'; id: number; value: any}
    | null {
    const ctx = (context ?? {}) as never;
    const decoded = this.transport.decode
      ? this.transport.decode(data as never, ctx)
      : data;

    if (this.mode === 'raw') {
      if (!decoded || typeof decoded !== 'object') return null;
      const wire = decoded as RawWireMessage;

      switch (wire.type) {
        case 'call':
          return {
            type: 'call',
            id: wire.id,
            method: wire.method,
            params: (wire.params ?? []) as any[],
          };
        case 'notification':
          return {
            type: 'notification',
            method: wire.method,
            params: (wire.params ?? []) as any[],
          };
        case 'result':
          return {type: 'result', id: wire.id, value: wire.value};
        case 'error':
          return {type: 'error', id: wire.id, value: wire.value};
        default:
          return null;
      }
    }

    const text = typeof decoded === 'string' ? decoded : String(decoded);
    const parsed = parseWireMessage(text);
    if (!parsed) return null;

    if (parsed.type === 'result' || parsed.type === 'error') {
      return {
        type: parsed.type,
        id: parsed.id,
        value: parseWireValue(parsed.payload),
      };
    }

    if (parsed.type === 'call') {
      return {
        type: 'call',
        id: parsed.id,
        method: parsed.method,
        params: parseWireParams(parsed.payload),
      };
    }

    return {
      type: 'notification',
      method: parsed.method,
      params: parseWireParams(parsed.payload),
    };
  }
}
