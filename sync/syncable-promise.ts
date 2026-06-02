import {SyncRPCAlreadyWaitedError} from './errors.ts';

/**
 * Descriptor of a deferred RPC call: the method name and arguments that
 * will be sent if and when the promise is consumed.
 *
 * @internal — used by internal modules that compose the sync path. Not
 * part of the public surface.
 */
export interface SyncableCallDescriptor {
  /** Method name (dotted path on the root, or `<id>#method` for handle methods). */
  method: string;
  /** Arguments to send with the call. */
  args: readonly unknown[];
}

/**
 * Brand symbol that makes the public `SyncablePromise<T>` interface
 * nominal — consumers cannot construct or satisfy it from outside this
 * module because they have no way to obtain `SYNCABLE_PROMISE_BRAND`.
 *
 * The symbol is declared but never exported, so this file is the only
 * place a `SyncablePromise<T>` can be produced.
 */
declare const SYNCABLE_PROMISE_BRAND: unique symbol;

/**
 * A `Promise<T>` whose wire send is deferred until first consumed.
 *
 * Every method stub on a hydrated client Proxy returns one of these, so
 * existing async code (`await rpc.root.foo()`, `Promise.all([...])`)
 * works unchanged AND `rpc.wait([rpc.root.foo()])` can claim the same
 * promise for the sync path.
 *
 * **Auto-fire-microtask semantics.** Construction queues a microtask
 * that fires the async wire send unless the promise has been claimed by
 * then. Three claim paths:
 *
 *   - `await` / `.then` / `.catch` / `.finally` — claim on the current
 *     tick via the overridden `.then`. The auto-fire microtask runs
 *     later, sees the consumed flag, and bails.
 *   - `rpc.wait([p])` — synchronous claim on the current tick via the
 *     library's internal `claimForSync` hook. Same race-free outcome.
 *   - Auto-fire microtask — for any unclaimed promise that survives one
 *     microtask tick. The async send fires so the promise resolves
 *     eventually; code that constructs a promise as a side effect
 *     doesn't hang.
 *
 * Double-dispatch is impossible by construction: one consumed flag, all
 * three claim sites respect it. A claim against an already-auto-fired
 * promise throws `SyncRPCAlreadyWaitedError` — the same loud failure
 * path as a double-await.
 *
 * `Symbol.species` is pinned to `Promise` so chained promises
 * (`p.then(x => ...)`) return a plain `Promise`, not a `SyncablePromise`.
 * A `.then` result is already-fired downstream work, never a wait
 * candidate.
 */
export interface SyncablePromise<T> extends Promise<T> {
  readonly [SYNCABLE_PROMISE_BRAND]: true;
}

/**
 * Per-instance state, keyed by the promise object. Module-private via
 * `WeakMap`; never reachable from consumer code, never appears in the
 * generated `.d.ts`. The class implementation reaches its own state via
 * the same map the helper functions use.
 */
interface SyncableInternals<T> {
  descriptor: SyncableCallDescriptor;
  /** Has this promise been claimed yet? */
  consumed: boolean;
  /** Which path claimed it (debugging / error messages). */
  consumer: 'async' | 'sync' | 'auto' | null;
  /** Resolve/reject the outer Promise. */
  resolve: (v: T | PromiseLike<T>) => void;
  reject: (e: unknown) => void;
  /**
   * Wire send for the async path. Provided by the constructing client.
   * Invoked when the first consumer is `await` / `.then` / `.catch` /
   * `.finally`, or by the auto-fire microtask if nothing else has
   * claimed.
   */
  asyncSend: (settle: {
    resolve: (v: T | PromiseLike<T>) => void;
    reject: (e: unknown) => void;
  }) => void;
}

const internals: WeakMap<object, SyncableInternals<unknown>> = new WeakMap();

/**
 * Fire the async send for an unconsumed promise. No-op if already
 * consumed. Centralized so the `await` path and the auto-fire microtask
 * share the same guard.
 */
function fireAsync(
  s: SyncableInternals<unknown>,
  consumer: 'async' | 'auto',
): void {
  if (s.consumed) return;
  s.consumed = true;
  s.consumer = consumer;
  try {
    s.asyncSend({resolve: s.resolve, reject: s.reject});
  } catch (err) {
    s.reject(err);
  }
}

/**
 * Runtime implementation of `SyncablePromise<T>`. Internal: not exported
 * from `mixed-signals/sync`. Construct via direct module import from
 * library code that owns the call's wire send.
 *
 * @internal
 */
export class SyncablePromiseImpl<T>
  extends Promise<T>
  implements SyncablePromise<T>
{
  declare readonly [SYNCABLE_PROMISE_BRAND]: true;

  constructor(
    descriptor: SyncableCallDescriptor,
    asyncSend: SyncableInternals<T>['asyncSend'],
  ) {
    // Guard against accidental misuse via inherited `Promise` statics
    // (`SyncablePromiseImpl.resolve(v)` etc. would otherwise produce a
    // half-built instance whose auto-fire microtask calls `undefined`,
    // leaking an unhandled rejection).
    if (typeof asyncSend !== 'function') {
      throw new TypeError(
        'SyncablePromiseImpl requires (descriptor, asyncSend); ' +
          'construct via internal library code, not via static factories.',
      );
    }
    let captured!: {
      resolve: (v: T | PromiseLike<T>) => void;
      reject: (e: unknown) => void;
    };
    super((resolve, reject) => {
      captured = {resolve, reject};
    });
    const state: SyncableInternals<unknown> = {
      descriptor,
      consumed: false,
      consumer: null,
      resolve: captured.resolve as SyncableInternals<unknown>['resolve'],
      reject: captured.reject,
      asyncSend: asyncSend as SyncableInternals<unknown>['asyncSend'],
    };
    internals.set(this, state);
    // Queue the auto-fire microtask. A synchronous `claimForSync(p)` or
    // `.then(...)` on the same tick wins the race; the microtask sees
    // `consumed === true` and bails.
    queueMicrotask(() => fireAsync(state, 'auto'));
  }

  /**
   * Chained promises do not inherit `SyncablePromise` semantics — a
   * `.then` result is already-fired downstream work, never a wait
   * candidate.
   */
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  override then<TResult1 = T, TResult2 = never>(
    onFulfilled?:
      | ((value: T) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onRejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined,
  ): Promise<TResult1 | TResult2> {
    const s = internals.get(this);
    if (s) fireAsync(s, 'async');
    return super.then(onFulfilled, onRejected);
  }
}

/**
 * Type guard for `SyncablePromise`.
 *
 * @internal
 */
export function isSyncablePromise(
  value: unknown,
): value is SyncablePromise<unknown> {
  return value instanceof SyncablePromiseImpl;
}

/**
 * Claim a `SyncablePromise` for the sync path. Returns the call
 * descriptor so the caller can batch it into the SAB envelope. Throws
 * `SyncRPCAlreadyWaitedError` if the promise has already been consumed,
 * or if the value is not a `SyncablePromise` produced by this module.
 *
 * @internal
 */
export function claimForSync<T>(
  p: SyncablePromise<T>,
): SyncableCallDescriptor {
  const s = internals.get(p as unknown as object);
  if (!s) {
    throw new SyncRPCAlreadyWaitedError(
      'value is not a SyncablePromise produced by this module',
    );
  }
  if (s.consumed) {
    throw new SyncRPCAlreadyWaitedError(
      `SyncablePromise already consumed by ${s.consumer ?? 'unknown path'}`,
    );
  }
  s.consumed = true;
  s.consumer = 'sync';
  return s.descriptor;
}

/**
 * Settle a sync-claimed `SyncablePromise` from the response timeline.
 * The promise's `.then` / `.catch` chain runs as usual; `await` on the
 * original promise resolves with `value` (or rejects with `error`).
 *
 * Throws if the promise was not previously claimed via `claimForSync` —
 * settling without a claim is an integration bug. The sync claim and
 * the wire response must be paired by the same code path.
 *
 * @internal
 */
export function settleSyncable<T>(
  p: SyncablePromise<T>,
  result: {ok: true; value: T} | {ok: false; error: unknown},
): void {
  const s = internals.get(p as unknown as object) as
    | SyncableInternals<T>
    | undefined;
  if (!s) {
    throw new Error(
      'settleSyncable called on a value that is not a SyncablePromise',
    );
  }
  if (s.consumer !== 'sync') {
    throw new Error(
      `settleSyncable requires a prior claimForSync; current consumer is ${s.consumer ?? 'unclaimed'}`,
    );
  }
  if (result.ok) s.resolve(result.value);
  else s.reject(result.error);
}
