import {
  PeerCodec,
  substituteBrandsAndCollectTransferables,
} from '../shared/codec.ts';
import {Hydrator} from '../shared/hydrate.ts';
import {
  PROMISE_REJECT_METHOD,
  PROMISE_RESOLVE_METHOD,
  ROOT_NOTIFICATION_METHOD,
  SIGNAL_UPDATE_METHOD,
  type Transport,
  type TransportContext,
} from '../shared/protocol.ts';
import {ClientReflection} from './reflection.ts';

/**
 * Client-side RPC hub.
 *
 * No model registration is required. Every incoming value is hydrated
 * automatically — Models and plain objects become `Proxy`s, functions become
 * callable proxies, promises become live `Promise`s, signals become real
 * `Signal`s wired to the watch/unwatch protocol.
 *
 * Works with either a `StringTransport` (the default — WebSocket, stdio,
 * etc.) or a `RawTransport` (postMessage / MessagePort / Worker). On the
 * raw path, outbound calls walk the arg tree to substitute branded remote
 * handles with `@H` markers and collect Transferable values into
 * `ctx.transfer`, which the transport hands to `postMessage(msg, ctx)`.
 */
export class RPCClient {
  private codec: PeerCodec;
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
    this.transportReady = transport.ready;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.reflection = new ClientReflection(this);
    this.hydrator = new Hydrator(this.reflection);
    this.reflection.setHydrator(this.hydrator);
    this.codec = new PeerCodec(transport, (marker) =>
      this.hydrator.hydrate(marker),
    );
    this.wireCodec();
  }

  reconnect(transport: Transport) {
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
    this.codec = new PeerCodec(transport, (marker) =>
      this.hydrator.hydrate(marker),
    );
    this.wireCodec();
  }

  private wireCodec() {
    this.codec.onMessage((msg) => {
      if (msg.type === 'result') {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        pending.resolve(msg.value);
        return;
      }
      if (msg.type === 'error') {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        pending.reject(
          new Error(
            ((msg.value as {message?: string}) ?? {}).message ?? 'RPC error',
          ),
        );
        return;
      }
      if (msg.type === 'call') return;

      this.handleNotification(msg.method, msg.params as any[]);
    });
  }

  async call(method: string, params?: any): Promise<any> {
    if (this.transportReady) await this.transportReady;
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {resolve, reject});
      const ctx: TransportContext = {};
      const walked = substituteBrandsAndCollectTransferables(
        params || [],
        ctx,
      ) as unknown[];
      this.codec.send({type: 'call', id, method, params: walked}, ctx);
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
    const sendIt = () => {
      const ctx: TransportContext = {};
      const walked = substituteBrandsAndCollectTransferables(
        params || [],
        ctx,
      ) as unknown[];
      this.codec.send({type: 'notification', method, params: walked}, ctx);
    };
    if (this.transportReady) {
      this.transportReady.then(sendIt);
    } else {
      sendIt();
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
