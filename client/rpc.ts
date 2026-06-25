import type {Signal} from '@preact/signals-core';
import {
  type ConnectionInfo,
  formatCallMessage,
  formatErrorMessage,
  formatNotificationMessage,
  formatResultMessage,
  parseWireMessage,
  parseWireParams,
  parseWireValue,
  REFRESH_MODELS_METHOD,
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

function isConnectionInfo(value: unknown): value is ConnectionInfo {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as ConnectionInfo).connectionId === 'string' &&
    typeof (value as ConnectionInfo).processId === 'string' &&
    typeof (value as ConnectionInfo).resumed === 'boolean'
  );
}

export class RPCClient {
  private transport: Transport;
  private transportGeneration = 0;
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
  private disconnectPromise!: Promise<never>;
  private _rejectDisconnect!: (reason?: unknown) => void;
  private closed = false;
  private disconnectError?: Error;
  private reconnectable = false;
  private readyResolved = false;
  private replaySubscriptionsOnRoot = false;
  root: any = undefined;
  /** Opaque server-assigned id that can be sent back on a future reconnect. */
  connectionId: string | undefined;
  /** Metadata from the server process that sent the latest root snapshot. */
  connectionInfo: ConnectionInfo | undefined;
  ready: Promise<void>;
  private _resolveReady!: () => void;
  private _rejectReady!: (reason?: unknown) => void;

  constructor(transport: Transport, ctx?: any) {
    this.transport = transport;
    this.transportReady = transport.ready;
    this.reconnectable = !!transport.onOpen;
    this.resetDisconnectPromise();
    this.ready = this.createReadyPromise();
    this.reflection = new ClientReflection(this, ctx);
    this.wireTransport(transport, this.transportGeneration);
  }

  /**
   * Replace the transport for a reconnection. Cached roots, signals and model
   * facades are kept alive so the next `@R` snapshot can refresh/rebind them,
   * then currently watched signals are replayed on the new connection.
   */
  reconnect(transport: Transport) {
    const error = new Error('Transport reconnected');
    for (const {reject} of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();

    this._rejectDisconnect(error);

    this.transportGeneration++;
    this.transport = transport;
    this.transportReady = transport.ready;
    this.reconnectable = !!transport.onOpen;
    this.closed = false;
    this.disconnectError = undefined;
    this.resetDisconnectPromise();
    this.reflection.prepareReconnect();
    this.replaySubscriptionsOnRoot = this.root !== undefined;
    this.ready = this.createReadyPromise();

    this.wireTransport(transport, this.transportGeneration);
  }

  private createReadyPromise(): Promise<void> {
    this.readyResolved = false;
    return new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
  }

  private resetDisconnectPromise() {
    this.disconnectPromise = new Promise((_, reject) => {
      this._rejectDisconnect = reject;
    });
    this.disconnectPromise.catch(() => undefined);
  }

  private wireTransport(transport: Transport, generation: number) {
    transport.ready?.then(
      () => this.handleOpen(generation),
      (error) => this.handleDisconnect(generation, error),
    );
    transport.onOpen?.(() => this.handleOpen(generation));
    transport.onClose?.((error) => this.handleDisconnect(generation, error));

    transport.onMessage((data) => {
      if (
        generation !== this.transportGeneration ||
        transport !== this.transport
      ) {
        return;
      }

      const message = parseWireMessage(data.toString());
      if (!message) return;

      const reviver = (_key: string, val: any) => {
        if (typeof val === 'object' && val) {
          if ('@S' in val) {
            return this.reflection.syncSignalSnapshot(val['@S'], val.v);
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
        this.handleCall(
          generation,
          transport,
          message.id,
          message.method,
          message.payload,
          reviver,
        );
        return;
      }

      if (message.method === ROOT_NOTIFICATION_METHOD) {
        const rawParams = parseWireParams(message.payload);
        this.prepareForRootSnapshot(rawParams);
      }

      const params = parseWireParams(message.payload, reviver);
      this.handleNotification(generation, message.method, params);
    });
  }

  private prepareForRootSnapshot(params: unknown[]) {
    const [, maybeConnectionInfo] = params;
    if (
      isConnectionInfo(maybeConnectionInfo) &&
      this.connectionInfo &&
      maybeConnectionInfo.processId !== this.connectionInfo.processId
    ) {
      this.reflection.prepareProcessChange();
    }
  }

  registerModel(typeName: string, ctor: any) {
    this.reflection.registerModel(typeName, ctor);
  }

  /** @internal */
  syncSignalIdentity(
    previousSignal: Signal<any>,
    nextSignal: Signal<any>,
  ): Signal<any> {
    return this.reflection.syncSignalIdentity(previousSignal, nextSignal);
  }

  /**
   * Publish an object as the dispatch target for peer-issued method
   * calls. Mirrors the server's `RPC.expose`: an inbound `M{id}:method`
   * frame is dispatched against this root using the same dot-notation
   * lookup the server uses for nested method calls (e.g. `"browser.logs"`
   * walks `root.browser.logs`). Returning a non-promise sends `R{id}`
   * with the value; throwing or rejecting sends `E{id}` with the
   * `{code, message}` shape. Calling `expose` again replaces the prior
   * root.
   */
  expose(root: any) {
    this.localRoot = root;
  }

  private sendOnTransport(
    generation: number,
    transport: Transport,
    message: string,
  ) {
    if (
      generation !== this.transportGeneration ||
      transport !== this.transport ||
      this.closed
    ) {
      return;
    }

    transport.send(message);
  }

  private handleCall(
    generation: number,
    transport: Transport,
    id: number,
    method: string,
    payload: string,
    reviver: (key: string, val: any) => any,
  ) {
    const segments = method.split('.');
    const methodName = segments.pop()!;
    const receiver =
      segments.length > 0
        ? dlv(this.localRoot, segments.join('.'))
        : this.localRoot;
    const target = receiver?.[methodName];
    if (typeof target !== 'function') {
      this.sendOnTransport(
        generation,
        transport,
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
      this.sendOnTransport(
        generation,
        transport,
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
        (result) =>
          this.sendOnTransport(
            generation,
            transport,
            formatResultMessage(id, result),
          ),
        (error: any) =>
          this.sendOnTransport(
            generation,
            transport,
            formatErrorMessage(id, {
              code: -1,
              message: error?.message ?? String(error),
            }),
          ),
      );
  }

  async call(method: string, params?: any): Promise<any> {
    if (this.closed) {
      throw this.getDisconnectError();
    }

    const generation = this.transportGeneration;
    const transport = this.transport;
    const ready = this.transportReady;

    if (ready) {
      await Promise.race([ready, this.disconnectPromise]);
    }

    if (
      generation !== this.transportGeneration ||
      transport !== this.transport
    ) {
      throw new Error('Transport reconnected');
    }

    if (this.closed) {
      throw this.getDisconnectError();
    }

    return new Promise((resolve, reject) => {
      this.sendCall(generation, transport, method, params, resolve, reject);
    });
  }

  notify(method: string, params?: any[]) {
    const message = formatNotificationMessage(method, params);
    const generation = this.transportGeneration;
    const transport = this.transport;
    const ready = this.transportReady;

    const send = () => this.sendOnTransport(generation, transport, message);

    if (ready) {
      ready.then(send, () => undefined);
    } else {
      send();
    }
  }

  private sendCall(
    generation: number,
    transport: Transport,
    method: string,
    params: any,
    resolve: (v: any) => void,
    reject: (e: any) => void,
  ) {
    if (
      this.closed ||
      generation !== this.transportGeneration ||
      transport !== this.transport
    ) {
      reject(
        this.closed
          ? this.getDisconnectError()
          : new Error('Transport reconnected'),
      );
      return;
    }

    const id = this.nextId++;
    this.pending.set(id, {resolve, reject});
    transport.send(formatCallMessage(id, method, params || []));
  }

  private handleOpen(generation: number) {
    if (generation !== this.transportGeneration) return;

    const wasClosed = this.closed;
    this.closed = false;
    this.disconnectError = undefined;
    this.transportReady = undefined;
    if (wasClosed) {
      this.resetDisconnectPromise();
    }
  }

  private handleDisconnect(generation: number, error?: unknown) {
    if (generation !== this.transportGeneration || this.closed) return;

    this.closed = true;
    this.disconnectError =
      error instanceof Error ? error : new Error('Transport disconnected');
    if (this.readyResolved) {
      this.replaySubscriptionsOnRoot = true;
    }

    this._rejectDisconnect(this.disconnectError);
    if (!this.readyResolved && !this.reconnectable) {
      this._rejectReady(this.disconnectError);
    }

    for (const {reject} of this.pending.values()) {
      reject(this.disconnectError);
    }

    this.pending.clear();
  }

  private getDisconnectError(): Error {
    return this.disconnectError ?? new Error('Transport disconnected');
  }

  onNotification(cb: (method: string, params: any[]) => void): () => void {
    this.notificationListeners.add(cb);
    return () => {
      this.notificationListeners.delete(cb);
    };
  }

  private async refreshHeldModelsAndReplay(generation: number) {
    const markers = this.reflection.getModelMarkers();
    if (markers.length === 0) {
      this.reflection.replayActiveSignals();
      return;
    }

    const refresh = this.call(REFRESH_MODELS_METHOD, markers);
    const replayed = this.reflection.replayActiveSignals();

    try {
      await refresh;
    } catch {
      // The reconnect may have been superseded or disconnected again. In both
      // cases replaying whatever ids we currently know is the safest fallback.
    } finally {
      if (generation === this.transportGeneration) {
        this.reflection.replayActiveSignals(replayed);
      }
    }
  }

  private handleNotification(
    generation: number,
    method: string,
    params: any[],
  ) {
    if (method === ROOT_NOTIFICATION_METHOD) {
      const [nextRoot, maybeConnectionInfo] = params;
      const hadRoot = this.root !== undefined;

      if (isConnectionInfo(maybeConnectionInfo)) {
        this.connectionInfo = maybeConnectionInfo;
        this.connectionId = maybeConnectionInfo.connectionId;
      }

      this.root = hadRoot
        ? this.reflection.reconcileRoot(this.root, nextRoot)
        : nextRoot;

      if (!this.readyResolved) {
        this.readyResolved = true;
        this._resolveReady();
      }

      if (this.replaySubscriptionsOnRoot) {
        this.replaySubscriptionsOnRoot = false;
        void this.refreshHeldModelsAndReplay(generation);
      }
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
