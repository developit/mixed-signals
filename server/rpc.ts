import {
  formatErrorMessage,
  formatNotificationMessage,
  formatRawErrorMessage,
  formatRawNotificationMessage,
  formatRawResultMessage,
  formatResultMessage,
  parseWireMessage,
  parseWireParams,
  parseWireValue,
  ROOT_NOTIFICATION_METHOD,
  type RawTransport,
  type RawWireMessage,
  type StringTransport,
  type Transport,
  UNWATCH_SIGNALS_METHOD,
  WATCH_SIGNALS_METHOD,
} from '../shared/protocol.ts';
import {
  ForwardedUpstream,
  isUpstreamId,
  stripInstancePrefix,
  stripSignalPrefix,
} from './forwarding.ts';
import {Instances} from './instances.ts';
import {Reflection} from './reflection.ts';

type ModelConstructor =
  | (new (
      ...args: any[]
    ) => any)
  | ((...args: any[]) => any);

// Allow dotted paths for nested method calls like "sessions.createSession".
function dlv(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

export class RPC {
  private reflection: Reflection;
  private clients = new Map<string, Transport>();
  private root: any;

  /** @internal */
  instances: Instances;

  /** Registered upstream connections for model forwarding. */
  private upstreams = new Map<string, ForwardedUpstream>();
  private nextUpstreamPrefix = 1;
  private clientModes = new Map<string, 'string' | 'raw'>();

  constructor(root?: any) {
    this.instances = new Instances();
    this.reflection = new Reflection(this, this.instances);

    if (root !== undefined) {
      this.expose(root);
    }
  }

  registerModel(name: string, Ctor: ModelConstructor) {
    this.reflection.registerModel(name, Ctor);
  }

  expose(root: any) {
    this.root = root;
    this.instances.register('0', root);
  }

  /**
   * Register an upstream mixed-signals connection whose models are forwarded
   * to downstream clients. All models from the upstream are automatically
   * forwarded — no per-model declaration needed.
   */
  addUpstream(transport: StringTransport): () => void {
    const prefix = String(this.nextUpstreamPrefix++);
    const upstream = new ForwardedUpstream(prefix, transport, this);
    this.upstreams.set(prefix, upstream);

    return () => {
      upstream.dispose();
      this.upstreams.delete(prefix);
    };
  }

  addClient(transport: Transport, clientId?: string): () => void {
    const id = clientId ?? crypto.randomUUID();
    const mode = transport.mode === 'raw' ? 'raw' : 'string';
    this.clients.set(id, transport);
    this.clientModes.set(id, mode);

    // Bind this client to any upstream connections
    for (const upstream of this.upstreams.values()) {
      upstream.setClient(id);
    }

    transport.onMessage(async (data, messageCtx) => {
      try {
        const incoming = this.readIncomingMessage(transport, data, messageCtx);
        if (!incoming) return;

        // Try forwarding first — if the message targets an upstream, handle it there.
        if (this.tryForwardClientMessage(id, incoming)) return;

        if (incoming.type === 'result' || incoming.type === 'error')
          return;

        const messageId = incoming.type === 'call' ? incoming.id : undefined;
        await this.handleMessage(id, messageId, incoming.method, incoming.params);
      } catch (err: any) {
        console.error('Failed to handle message:', err);
      }
    });

    // Only send @R once ALL upstreams have delivered their root.
    // If any upstream is still pending, onUpstreamRootChanged will
    // send the single merged @R when the last one arrives.
    if (this.allUpstreamsReady()) {
      this.broadcastMergedRoot(id);
    }

    return () => {
      this.clients.delete(id);
      this.clientModes.delete(id);
      this.reflection.removeClient(id);
      for (const upstream of this.upstreams.values()) {
        upstream.removeClient(id);
      }
    };
  }

  /**
   * Called by ForwardedUpstream when the upstream root changes.
   * Sends the merged root to all clients once every upstream has reported.
   * @internal
   */
  onUpstreamRootChanged() {
    if (!this.allUpstreamsReady()) return;

    for (const clientId of this.clients.keys()) {
      this.broadcastMergedRoot(clientId);
    }
  }

  private allUpstreamsReady(): boolean {
    for (const upstream of this.upstreams.values()) {
      if (upstream.root === undefined) return false;
    }
    return true;
  }

  private broadcastMergedRoot(clientId: string) {
    const raw = this.isRawClient(clientId);
    const localRoot =
      this.root !== undefined
        ? this.reflection.serializeForTransport(this.root, clientId, raw)
        : undefined;
    this.sendMergedRoot(clientId, localRoot);
  }

  /**
   * Merge local root with upstream roots and send to a client.
   */
  private sendMergedRoot(clientId: string, localRoot: any) {
    let merged = localRoot;

    for (const upstream of this.upstreams.values()) {
      if (upstream.root) {
        if (merged && typeof merged === 'object' && !Array.isArray(merged)) {
          merged = {...merged, ...upstream.root};
        } else {
          merged = upstream.root;
        }
      }
    }

    if (merged !== undefined) {
      this.send(
        clientId,
        this.isRawClient(clientId)
          ? formatRawNotificationMessage(ROOT_NOTIFICATION_METHOD, [merged])
          : formatNotificationMessage(ROOT_NOTIFICATION_METHOD, [merged]),
      );
    }
  }

  /**
   * Intercept a client message and forward it to an upstream if it targets
   * forwarded models/signals. Returns true if the message was forwarded.
   */
  private tryForwardClientMessage(
    clientId: string,
    parsed: RawWireMessage,
  ): boolean {

    // @W and @U: split signal IDs between local and upstream
    if (
      parsed.type === 'notification' &&
      (parsed.method === WATCH_SIGNALS_METHOD ||
        parsed.method === UNWATCH_SIGNALS_METHOD)
    ) {
      const ids = parsed.params as (number | string)[];
      const localIds: number[] = [];

      // Group upstream IDs by prefix
      const upstreamBatches = new Map<ForwardedUpstream, number[]>();
      for (const id of ids) {
        const upstream = this.findUpstreamForSignal(id);
        if (upstream) {
          let batch = upstreamBatches.get(upstream);
          if (!batch) {
            batch = [];
            upstreamBatches.set(upstream, batch);
          }
          batch.push(stripSignalPrefix(upstream.prefix, id as string));
        } else {
          localIds.push(id as number);
        }
      }

      // If no upstream IDs, let the normal handleMessage path deal with it.
      if (upstreamBatches.size === 0) return false;

      // Forward to each upstream
      for (const [upstream, signalIds] of upstreamBatches) {
        if (parsed.method === WATCH_SIGNALS_METHOD) {
          upstream.forwardWatch(signalIds);
        } else {
          upstream.forwardUnwatch(signalIds);
        }
      }

      // Handle local IDs through existing Reflection
      for (const signalId of localIds) {
        if (parsed.method === WATCH_SIGNALS_METHOD) {
          this.reflection.watch(clientId, signalId);
        } else {
          this.reflection.unwatch(clientId, signalId);
        }
      }

      return true; // Fully handled (mix of local + upstream)
    }

    // Method calls: check if wireId has an upstream prefix
    if (parsed.type === 'call') {
      const hashIdx = parsed.method.indexOf('#');
      if (hashIdx !== -1) {
        const wireId = parsed.method.slice(0, hashIdx);
        const upstream = this.findUpstreamForInstance(wireId);
        if (upstream) {
          const strippedWireId = stripInstancePrefix(upstream.prefix, wireId);
          const methodName = parsed.method.slice(hashIdx + 1);
          upstream.forwardCall(
            clientId,
            parsed.id,
            `${strippedWireId}#${methodName}`,
            this.stringifyParams(parsed.params),
          );
          return true;
        }
      }
    }

    return false;
  }

  private findUpstreamForSignal(
    id: number | string,
  ): ForwardedUpstream | undefined {
    if (typeof id !== 'string') return undefined;
    for (const upstream of this.upstreams.values()) {
      if (isUpstreamId(upstream.prefix, id)) return upstream;
    }
  }

  private findUpstreamForInstance(
    wireId: string,
  ): ForwardedUpstream | undefined {
    for (const upstream of this.upstreams.values()) {
      if (isUpstreamId(upstream.prefix, wireId)) return upstream;
    }
  }

  private async handleMessage(
    clientId: string,
    id: number | undefined,
    method: string,
    params: any[],
  ) {
    if (method === WATCH_SIGNALS_METHOD) {
      for (const signalId of params) {
        this.reflection.watch(clientId, signalId);
      }

      return;
    }

    if (method === UNWATCH_SIGNALS_METHOD) {
      for (const signalId of params) {
        this.reflection.unwatch(clientId, signalId);
      }

      return;
    }

    try {
      const result = await this.callMethod(method, params);
      const serialized = this.reflection.serializeForTransport(
        result,
        clientId,
        this.isRawClient(clientId),
      );

      if (id !== undefined) {
        this.sendResult(clientId, id, serialized);
      }
    } catch (error: any) {
      if (id !== undefined) {
        this.sendError(clientId, id, {code: -1, message: error.message});
      }
    }
  }

  private async callMethod(method: string, params: any) {
    const args = params || [];

    let instance = this.root;
    const hashIdx = method.indexOf('#');
    if (hashIdx !== -1) {
      // Instance routes look like "<wireId>#method".
      const id = method.slice(0, hashIdx);
      method = method.slice(hashIdx + 1);
      instance = this.instances.get(id);

      if (!instance) throw new Error(`Instance not found: ${id}`);
    }

    const segments = method.split('.');
    const methodName = segments.pop()!;
    const receiver =
      segments.length > 0 ? dlv(instance, segments.join('.')) : instance;
    const target = receiver?.[methodName];
    if (typeof target !== 'function') {
      throw new Error(`Method not found: ${method}`);
    }

    return target.apply(receiver, args);
  }

  notify(method: string, params: any[], clientId?: string) {
    if (clientId) {
      const transport = this.clients.get(clientId);
      if (!transport) return;
      const raw = this.isRawClient(clientId);
      const message = raw
        ? formatRawNotificationMessage(method, params)
        : formatNotificationMessage(method, params);
      this.send(clientId, message);
    } else {
      for (const [id] of this.clients.entries()) {
        const raw = this.isRawClient(id);
        const message = raw
          ? formatRawNotificationMessage(method, params)
          : formatNotificationMessage(method, params);
        this.send(id, message);
      }
    }
  }

  /** @internal */
  send(clientId: string, message: string | RawWireMessage) {
    const transport = this.clients.get(clientId);
    if (!transport) return;
    const ctx = {};
    if (this.isRawClient(clientId)) {
      const output = transport.encode ? transport.encode(message, ctx as never) : message;
      (transport as RawTransport).send(output, ctx as never);
      return;
    }

    const output = transport.encode
      ? transport.encode(message, ctx as never)
      : (typeof message === 'string' ? message : JSON.stringify(message));
    (transport as StringTransport).send(String(output), ctx as never);
  }

  isRawClient(clientId: string): boolean {
    return this.clientModes.get(clientId) === 'raw';
  }

  private sendResult(clientId: string, id: number, result: any) {
    const transport = this.clients.get(clientId);
    if (!transport) return;
    this.send(
      clientId,
      this.isRawClient(clientId)
        ? formatRawResultMessage(id, result)
        : formatResultMessage(id, result),
    );
  }

  private sendError(clientId: string, id: number, error: any) {
    const transport = this.clients.get(clientId);
    if (!transport) return;
    this.send(
      clientId,
      this.isRawClient(clientId)
        ? formatRawErrorMessage(id, error)
        : formatErrorMessage(id, error),
    );
  }

  private readIncomingMessage(
    transport: Transport,
    data: unknown,
    context: unknown,
  ): RawWireMessage | null {
    const ctx = (context ?? {}) as never;
    const decoded = transport.decode ? transport.decode(data as never, ctx) : data;

    if (transport.mode === 'raw') {
      if (!decoded || typeof decoded !== 'object') return null;
      return decoded as RawWireMessage;
    }

    const text = typeof decoded === 'string' ? decoded : String(decoded);
    const parsed = parseWireMessage(text);
    if (!parsed) return null;

    switch (parsed.type) {
      case 'call':
        return {
          type: 'call',
          id: parsed.id,
          method: parsed.method,
          params: parseWireParams(parsed.payload),
        };
      case 'notification':
        return {
          type: 'notification',
          method: parsed.method,
          params: parseWireParams(parsed.payload),
        };
      case 'result':
        return {type: 'result', id: parsed.id, value: parseWireValue(parsed.payload)};
      case 'error':
        return {type: 'error', id: parsed.id, value: parseWireValue(parsed.payload)};
    }
  }

  private stringifyParams(params: unknown[]): string {
    if (params.length === 0) return '';
    let output = '';
    for (let i = 0; i < params.length; i++) {
      if (i > 0) output += ',';
      output += JSON.stringify(params[i]);
    }
    return output;
  }
}
