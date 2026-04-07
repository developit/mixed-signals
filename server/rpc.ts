import {
  formatErrorMessage,
  formatNotificationMessage,
  formatResultMessage,
  parseWireMessage,
  parseWireParams,
  ROOT_NOTIFICATION_METHOD,
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
  addUpstream(transport: Transport): () => void {
    const prefix = String(this.nextUpstreamPrefix++);
    const upstream = new ForwardedUpstream(prefix, transport, this);
    this.upstreams.set(prefix, upstream);

    // Bind any already-connected clients to the new upstream
    for (const clientId of this.clients.keys()) {
      upstream.setClient(clientId);
    }

    return () => {
      upstream.dispose();
      this.upstreams.delete(prefix);
    };
  }

  addClient(transport: Transport, clientId?: string): () => void {
    const id = clientId ?? crypto.randomUUID();
    this.clients.set(id, transport);

    // Bind this client to any upstream connections
    for (const upstream of this.upstreams.values()) {
      upstream.setClient(id);
    }

    transport.onMessage(async (data) => {
      try {
        const raw = data.toString();

        // Try forwarding first — if the message targets an upstream, handle it there.
        if (this.tryForwardClientMessage(id, raw)) return;

        const message = parseWireMessage(raw);
        if (!message || message.type === 'result' || message.type === 'error')
          return;

        const params = parseWireParams(message.payload);
        const messageId = message.type === 'call' ? message.id : undefined;
        await this.handleMessage(id, messageId, message.method, params);
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
    const localRoot =
      this.root !== undefined
        ? this.reflection.serialize(this.root, clientId)
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
        formatNotificationMessage(ROOT_NOTIFICATION_METHOD, [merged]),
      );
    }
  }

  /**
   * Intercept a client message and forward it to an upstream if it targets
   * forwarded models/signals. Returns true if the message was forwarded.
   */
  private tryForwardClientMessage(clientId: string, raw: string): boolean {
    const parsed = parseWireMessage(raw);
    if (!parsed) return false;

    // @W and @U: split signal IDs between local and upstream
    if (
      parsed.type === 'notification' &&
      (parsed.method === WATCH_SIGNALS_METHOD ||
        parsed.method === UNWATCH_SIGNALS_METHOD)
    ) {
      const ids = parseWireParams<(number | string)[]>(parsed.payload);
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
            parsed.payload,
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
      const serialized = this.reflection.serialize(result, clientId);

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
    const message = formatNotificationMessage(method, params);

    if (clientId) {
      this.clients.get(clientId)?.send(message);
    } else {
      for (const transport of this.clients.values()) {
        transport.send(message);
      }
    }
  }

  /** @internal */
  send(clientId: string, message: string) {
    const transport = this.clients.get(clientId);
    if (!transport) return;

    transport.send(message);
  }

  private sendResult(clientId: string, id: number, result: any) {
    this.send(clientId, formatResultMessage(id, result));
  }

  private sendError(clientId: string, id: number, error: any) {
    this.send(clientId, formatErrorMessage(id, error));
  }
}
