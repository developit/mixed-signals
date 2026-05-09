import {
  formatCallMessage,
  formatErrorMessage,
  formatNotificationMessage,
  formatResultMessage,
  parseWireMessage,
  parseWireParams,
  parseWireValue,
  ROOT_NOTIFICATION_METHOD,
  SIGNAL_UPDATE_METHOD,
  type Transport,
} from '../shared/protocol.ts';
import {ClientReflection} from './reflection.ts';

// Walk a dotted path like "browser.logs" against an object so peer-issued
// calls can target nested methods on the exposed root.
function dlv(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

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
  private localRoot: any;
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
    this.wireTransport(transport);
  }

  /**
   * Replace the transport and reset internal state for a reconnection.
   * A new `ready` promise is created that resolves on the next `@R` message.
   */
  reconnect(transport: Transport) {
    this.transport = transport;
    this.transportReady = transport.ready;

    // Reject all in-flight RPCs
    for (const {reject} of this.pending.values()) {
      reject(new Error('Transport reconnected'));
    }
    this.pending.clear();

    // Clear reflection caches so the fresh @R rebuilds everything
    this.reflection.reset();

    // Fresh ready gate
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });

    this.wireTransport(transport);
  }

  private wireTransport(transport: Transport) {
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

      if (message.type === 'call') {
        this.handleCall(message.id, message.method, message.payload, reviver);
        return;
      }

      const params = parseWireParams(message.payload, reviver);
      this.handleNotification(message.method, params);
    });
  }

  registerModel(typeName: string, ctor: any) {
    this.reflection.registerModel(typeName, ctor);
  }

  /**
   * Publish an object as the dispatch target for peer-issued method
   * calls. Mirrors the server's `RPC.expose`: an inbound `M{id}:method`
   * frame is dispatched against this root using the same dot-notation
   * lookup the server uses for nested methods (e.g. `"browser.logs"`
   * walks `root.browser.logs`). Returning a non-promise sends `R{id}`
   * with the value; throwing or rejecting sends `E{id}` with the
   * `{code, message}` shape. Calling `expose` again replaces the prior
   * root.
   */
  expose(root: any) {
    this.localRoot = root;
  }

  private handleCall(
    id: number,
    method: string,
    payload: string,
    reviver: (key: string, val: any) => any,
  ) {
    const segments = method.split('.');
    const methodName = segments.pop()!;
    const receiver =
      segments.length > 0 ? dlv(this.localRoot, segments.join('.')) : this.localRoot;
    const target = receiver?.[methodName];
    if (typeof target !== 'function') {
      this.transport.send(
        formatErrorMessage(id, {
          code: -1,
          message: `Method not found: ${method}`,
        }),
      );
      return;
    }
    let params: unknown[];
    try {
      params = parseWireParams(payload, reviver);
    } catch (error: any) {
      this.transport.send(
        formatErrorMessage(id, {
          code: -1,
          message: error?.message ?? String(error),
        }),
      );
      return;
    }
    Promise.resolve()
      .then(() => target.apply(receiver, params))
      .then(
        (result) => this.transport.send(formatResultMessage(id, result)),
        (error: any) =>
          this.transport.send(
            formatErrorMessage(id, {
              code: -1,
              message: error?.message ?? String(error),
            }),
          ),
      );
  }

  async call(method: string, params?: any): Promise<any> {
    if (this.transportReady) await this.transportReady;
    return new Promise((resolve, reject) => {
      this.sendCall(method, params, resolve, reject);
    });
  }

  notify(method: string, params?: any[]) {
    const message = formatNotificationMessage(method, params);
    if (this.transportReady) {
      this.transportReady.then(() => this.transport.send(message));
    } else {
      this.transport.send(message);
    }
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
