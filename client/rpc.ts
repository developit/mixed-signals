import {
  formatCallMessage,
  formatNotificationMessage,
  parseWireMessage,
  parseWireParams,
  parseWireValue,
  ROOT_NOTIFICATION_METHOD,
  SIGNAL_UPDATE_METHOD,
  type Transport,
} from '../shared/protocol.ts';
import {ClientReflection} from './reflection.ts';

export class RPCClient {
  private transport: Transport;
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
    this.transportReady = transport.ready;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.reflection = new ClientReflection(this, ctx);

    transport.onMessage((data) => {
      const message = parseWireMessage(data.toString());
      if (!message) return;

      const reviver = (_key: string, val: any) => {
        if (typeof val === 'object' && val) {
          if ('@S' in val) {
            return this.reflection.getOrCreateSignal(val['@S'], val.v);
          }

          if ('@M' in val) {
            return this.reflection.createModelFacade(val);
          }
        }

        return val;
      };

      if (message.type === 'result' || message.type === 'error') {
        const parsed = parseWireValue(message.payload, reviver);
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

      const params = parseWireParams(message.payload, reviver);
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
    this.transport.send(formatNotificationMessage(method, params));
  }

  private sendCall(
    method: string,
    params: any,
    resolve: (v: any) => void,
    reject: (e: any) => void,
  ) {
    const id = this.nextId++;
    this.pending.set(id, {resolve, reject});
    this.transport.send(formatCallMessage(id, method, params || []));
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
}
