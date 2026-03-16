import {Instances} from './instances';
import {Reflection} from './reflection';

export interface Transport {
  send(data: string): void;
  onMessage(cb: (data: {toString(): string}) => void): void;
  ready?: Promise<void>;
}

export class RPC {
  private reflection: Reflection;
  private clients = new Map<string, Transport>();
  private _root: any;
  instances: Instances;

  constructor() {
    this.instances = new Instances();
    this.reflection = new Reflection(this, this.instances);
  }

  registerModel(name: string, Ctor: new (...args: any[]) => any) {
    this.reflection.registerModel(name, Ctor);
  }

  expose(root: any) {
    this._root = root;
    this.instances.register('0', root);
  }

  addClient(transport: Transport, clientId?: string): () => void {
    const id = clientId ?? crypto.randomUUID();
    this.clients.set(id, transport);

    transport.onMessage(async (data) => {
      try {
        const dataStr = data.toString();

        // Parse with regex: [MN]123:method:payload
        const parts = dataStr.match(/^[MN](\d*):([^:]*?):(.*)$/);
        if (!parts) return;

        const idRaw = parts[1];
        const msgId = idRaw ? +idRaw : undefined;
        const method = parts[2];
        const paramsRaw = parts[3];

        const params = JSON.parse('[' + paramsRaw + ']');

        await this.handleMessage(id, msgId, method, params);
      } catch (err: any) {
        console.error('Failed to handle message:', err);
      }
    });

    // Send root model on connect
    if (this._root) {
      const serialized = this.reflection.serialize(this._root, id);
      transport.send(`N:@R:${JSON.stringify(serialized)}`);
    }

    return () => {
      this.clients.delete(id);
      this.reflection.removeClient(id);
    };
  }

  private async handleMessage(
    clientId: string,
    id: number | undefined,
    method: string,
    params: any[],
  ) {
    if (method === '@W') {
      for (const signalId of params) {
        this.reflection.watch(clientId, signalId);
      }
      return;
    }

    if (method === '@U') {
      for (const signalId of params) {
        this.reflection.unwatch(clientId, signalId);
      }
      return;
    }

    if (method) {
      try {
        const result = await this.callMethod(method, params);
        const serialized = this.reflection.serialize(result, clientId);
        this.send(clientId, {id, result: serialized});
      } catch (error: any) {
        if (id !== undefined) {
          this.send(clientId, {
            id,
            error: {code: -1, message: error.message},
          });
        }
      }
    }
  }

  private async callMethod(method: string, params: any) {
    const args = params || [];

    let instance = this._root;
    // Instance methods: id#method (string IDs — may be UUIDs)
    const hashIdx = method.indexOf('#');
    if (hashIdx !== -1) {
      const id = method.slice(0, hashIdx);
      method = method.slice(hashIdx + 1);
      instance = this.instances.get(id);
      if (!instance) throw new Error(`Instance not found: ${id}`);
    }

    let parent = instance;
    let target = instance;
    const parts = method.split('.');
    for (let i = 0; i < parts.length; i++) {
      if (target == null) {
        target = undefined;
        break;
      }
      parent = target;
      target = target[parts[i]];
    }

    if (typeof target !== 'function') {
      throw new Error(`Method not found: ${method}`);
    }
    return target.apply(parent, args);
  }

  notify(method: string, params: any[], clientId?: string) {
    const paramStr = params.map((p) => JSON.stringify(p)).join(',');
    const msg = `N:${method}:${paramStr}`;

    if (clientId) {
      this.clients.get(clientId)?.send(msg);
    } else {
      for (const transport of this.clients.values()) {
        transport.send(msg);
      }
    }
  }

  send(clientId: string, msg: any) {
    const transport = this.clients.get(clientId);
    if (!transport) return;

    let message: string;

    if (typeof msg === 'string') {
      message = msg;
    } else if ('result' in msg) {
      message = `R${msg.id}:${JSON.stringify(msg.result)}`;
    } else if ('error' in msg) {
      message = `E${msg.id}:${JSON.stringify(msg.error)}`;
    } else {
      message = JSON.stringify(msg);
    }

    transport.send(message);
  }
}
