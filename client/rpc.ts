import {BRAND_REMOTE, type RemoteBrand} from '../shared/brand.ts';
import {Hydrator} from '../shared/hydrate.ts';
import {
  formatCallMessage,
  formatNotificationMessage,
  HANDLE_MARKER,
  PROMISE_REJECT_METHOD,
  PROMISE_RESOLVE_METHOD,
  parseWireMessage,
  parseWireParams,
  parseWireValue,
  ROOT_NOTIFICATION_METHOD,
  SIGNAL_UPDATE_METHOD,
  type Transport,
} from '../shared/protocol.ts';
import {ClientReflection} from './reflection.ts';

/**
 * JSON.stringify replacer used for client → server values. Detects branded
 * remote Proxies / Signals / functions and re-emits them as bare `@H` markers
 * so the server resolves them back to the original object by id.
 *
 * The brand is a non-enumerable own symbol, so JSON.stringify's default walk
 * would miss it — we explicitly check each visited value.
 */
function outboundReplacer(_key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t !== 'object' && t !== 'function') return value;
  const brand = (value as any)[BRAND_REMOTE] as RemoteBrand | undefined;
  if (brand) return {[HANDLE_MARKER]: brand.id};
  return value;
}

/**
 * Client-side RPC hub.
 *
 * No model registration is required. Every incoming value is hydrated
 * automatically — Models and plain objects become `Proxy`s, functions become
 * callable proxies, promises become live `Promise`s, signals become real
 * `Signal`s wired to the watch/unwatch protocol.
 */
export class RPCClient {
  private transport: Transport;
  private nextId = 1;
  private pending = new Map<
    number,
    {resolve(v: any): void; reject(e: any): void}
  >();
  private notificationListeners = new Set<
    (method: string, params: any[]) => void
  >();

  /** @internal */
  reflection: ClientReflection;
  /** @internal */
  hydrator: Hydrator;

  private transportReady: Promise<void> | undefined;
  root: any = undefined;
  ready: Promise<void>;
  private _resolveReady!: () => void;

  constructor(transport: Transport, _ctx?: any) {
    this.transport = transport;
    this.transportReady = transport.ready;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.reflection = new ClientReflection(this);
    this.hydrator = new Hydrator(this.reflection);
    this.reflection.setHydrator(this.hydrator);
    this.wireTransport(transport);
  }

  reconnect(transport: Transport) {
    this.transport = transport;
    this.transportReady = transport.ready;
    for (const {reject} of this.pending.values()) {
      reject(new Error('Transport reconnected'));
    }
    this.pending.clear();
    this.reflection.reset();
    this.hydrator.reset();
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.wireTransport(transport);
  }

  private wireTransport(transport: Transport) {
    transport.onMessage((data) => {
      const message = parseWireMessage(data.toString());
      if (!message) return;
      const reviver = this.hydrator.reviver;

      if (message.type === 'result' || message.type === 'error') {
        const parsed = parseWireValue(message.payload, reviver);
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.type === 'result') pending.resolve(parsed);
        else pending.reject(new Error((parsed as {message?: string}).message));
        return;
      }
      if (message.type === 'call') return;

      const params = parseWireParams(message.payload, reviver);
      this.handleNotification(message.method, params);
    });
  }

  async call(method: string, params?: any): Promise<any> {
    if (this.transportReady) await this.transportReady;
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {resolve, reject});
      this.transport.send(
        formatCallMessage(id, method, params || [], outboundReplacer),
      );
    });
  }

  /**
   * Resolve the constructor for a remote class by name. Every class instance
   * the client has hydrated is built on a shared prototype, so you can use
   * the returned function with `instanceof`:
   *
   *   const Counter = client.classOf('Counter');
   *   value instanceof Counter;
   *
   * Returns `undefined` if no instance of a class with that name has been
   * received yet.
   */
  classOf(name: string): (new () => any) | undefined {
    return this.hydrator.classOf(name);
  }

  notify(method: string, params?: any[]) {
    const message = formatNotificationMessage(method, params, outboundReplacer);
    if (this.transportReady) {
      this.transportReady.then(() => this.transport.send(message));
    } else {
      this.transport.send(message);
    }
  }

  onNotification(cb: (method: string, params: any[]) => void): () => void {
    this.notificationListeners.add(cb);
    return () => this.notificationListeners.delete(cb);
  }

  private handleNotification(method: string, params: any[]) {
    if (method === ROOT_NOTIFICATION_METHOD) {
      this.root = params[0];
      this._resolveReady();
    } else if (method === SIGNAL_UPDATE_METHOD) {
      const [id, value, mode] = params as [string, any, string?];
      this.hydrator.applySignalUpdate(id, value, mode);
    } else if (method === PROMISE_RESOLVE_METHOD) {
      const [id, value] = params as [string, any];
      this.reflection.settlePromise(id, value, false);
    } else if (method === PROMISE_REJECT_METHOD) {
      const [id, value] = params as [string, any];
      this.reflection.settlePromise(id, value, true);
    } else {
      for (const listener of this.notificationListeners) {
        listener(method, params);
      }
    }
  }
}
