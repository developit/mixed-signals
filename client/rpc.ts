import type {Transport} from '../server/rpc';
import type {WireContext} from './reflection';
import {ClientReflection} from './reflection';

export class RPCClient {
  private transport: Transport;
  private nextId = 1;
  private pending = new Map<
    number,
    {resolve: (v: any) => void; reject: (e: any) => void}
  >();
  reflection: ClientReflection;
  private transportReady: Promise<void> | undefined;
  root: any = undefined;
  ready: Promise<void>;
  private _resolveReady!: () => void;
  private notificationListeners = new Set<
    (method: string, params: any[]) => void
  >();

  constructor(transport: Transport, ctx: WireContext) {
    this.transport = transport;
    this.transportReady = transport.ready;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.reflection = new ClientReflection(this, ctx);

    transport.onMessage((data) => {
      const str = data.toString();
      const type = str[0];

      // Reviver for processing @S and @M markers
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

      // Parse with regex: [ER]123:payload or [MN]123:method:payload
      const parts = str.match(/^(?:[ER](\d+)|[MN](\d*):([^:]*?)):(.*)$/);
      if (!parts) return;

      const idRaw = parts[1] || parts[2];
      const id = idRaw ? +idRaw : undefined;
      const method = parts[3];
      const paramsRaw = parts[4];

      if (type === 'R' || type === 'E') {
        const parsed = JSON.parse(paramsRaw, reviver);
        const pending = this.pending.get(id!);
        if (!pending) return;
        this.pending.delete(id!);
        if (type === 'R') pending.resolve(parsed);
        else pending.reject(new Error(parsed.message));
      } else if (type === 'M') {
        // M messages shouldn't be sent to client
      } else {
        // type === 'N'
        const params = JSON.parse('[' + paramsRaw + ']', reviver);
        this.handleNotification(method, params);
      }
    });
  }

  async call(method: string, params?: any): Promise<any> {
    if (this.transportReady) await this.transportReady;
    return new Promise((resolve, reject) => {
      this.sendCall(method, params, resolve, reject);
    });
  }

  onNotification(cb: (method: string, params: any[]) => void): () => void {
    this.notificationListeners.add(cb);
    return () => {
      this.notificationListeners.delete(cb);
    };
  }

  notify(method: string, params?: any[]) {
    const paramStr = (params || []).map((p) => JSON.stringify(p)).join(',');
    const message = `N:${method}:${paramStr}`;
    this.transport.send(message);
  }

  private sendCall(
    method: string,
    params: any,
    resolve: (v: any) => void,
    reject: (e: any) => void,
  ) {
    const id = this.nextId++;
    this.pending.set(id, {resolve, reject});

    const paramStr = JSON.stringify(params || []).slice(1, -1);
    const message = `M${id}:${method}:${paramStr}`;

    this.transport.send(message);
  }

  private handleNotification(method: string, params: any[]) {
    if (method === '@R') {
      this.root = params[0];
      this._resolveReady();
      return;
    }

    if (method === '@S') {
      const [id, value, mode] = params;
      this.reflection.handleUpdate(id, value, mode);
      return;
    }

    for (const listener of this.notificationListeners) {
      listener(method, params);
    }
  }
}
