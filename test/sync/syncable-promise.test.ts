import {describe, expect, it} from 'vitest';
import {SyncRPCAlreadyWaitedError} from '../../sync/errors.ts';
import {
  claimForSync,
  isSyncablePromise,
  settleSyncable,
  SyncablePromiseImpl,
} from '../../sync/syncable-promise.ts';

function spy() {
  let calls = 0;
  let lastArg: unknown = undefined;
  const fn = (arg?: unknown) => {
    calls++;
    lastArg = arg;
  };
  return {
    fn,
    get calls() {
      return calls;
    },
    get lastArg() {
      return lastArg;
    },
  };
}

describe('SyncablePromiseImpl', () => {
  it('does not invoke asyncSend synchronously at construction (queued for next microtask)', () => {
    const sent = spy();
    new SyncablePromiseImpl<string>({method: 'foo', args: []}, sent.fn);
    expect(sent.calls).toBe(0);
  });

  it('auto-fires asyncSend one microtask after construction', async () => {
    const sent = spy();
    new SyncablePromiseImpl<string>({method: 'foo', args: []}, sent.fn);
    await Promise.resolve();
    expect(sent.calls).toBe(1);
  });

  it('fires asyncSend when consumed by `await` (.then, one microtask later)', async () => {
    let resolveSent: ((v: string) => void) | undefined;
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: []},
      (s) => {
        resolveSent = s.resolve as (v: string) => void;
      },
    );

    // `await p` queues a thenable job that calls .then on the next
    // microtask. Flushing one microtask is enough to observe the send.
    const awaited = (async () => await p)();
    await Promise.resolve();
    expect(resolveSent).toBeDefined();

    resolveSent!('hello');
    expect(await awaited).toBe('hello');
  });

  it('fires asyncSend when consumed by .catch', () => {
    const sent = spy();
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: []},
      sent.fn,
    );
    void p.catch(() => undefined);
    expect(sent.calls).toBe(1);
  });

  it('fires asyncSend when consumed by .finally', () => {
    const sent = spy();
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: []},
      sent.fn,
    );
    void p.finally(() => undefined);
    expect(sent.calls).toBe(1);
  });

  it('fires asyncSend exactly once across multiple .then calls', () => {
    const sent = spy();
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: []},
      sent.fn,
    );
    void p.then(() => undefined);
    void p.then(() => undefined);
    void p.then(() => undefined);
    expect(sent.calls).toBe(1);
  });

  it('fires asyncSend when used in Promise.all (microtask-deferred)', async () => {
    let resolveA: ((v: number) => void) | undefined;
    let resolveB: ((v: number) => void) | undefined;
    const a = new SyncablePromiseImpl<number>({method: 'a', args: []}, (s) => {
      resolveA = s.resolve as (v: number) => void;
    });
    const b = new SyncablePromiseImpl<number>({method: 'b', args: []}, (s) => {
      resolveB = s.resolve as (v: number) => void;
    });

    // Same story as `await`: Promise.all routes through PromiseResolve which
    // queues a thenable job because SyncablePromise.constructor !== %Promise%.
    const combined = Promise.all([a, b]);
    await Promise.resolve();
    expect(resolveA).toBeDefined();
    expect(resolveB).toBeDefined();
    resolveA!(1);
    resolveB!(2);
    expect(await combined).toEqual([1, 2]);
  });

  it('rejects when asyncSend throws synchronously', async () => {
    const boom = new Error('send failed');
    const p = new SyncablePromiseImpl<string>({method: 'foo', args: []}, () => {
      throw boom;
    });
    await expect(p).rejects.toBe(boom);
  });

  it('claimForSync (synchronous, same tick) wins the race against auto-fire', async () => {
    const sent = spy();
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: [1, 'two']},
      sent.fn,
    );
    // Synchronously claim before the auto-fire microtask runs.
    const desc = claimForSync(p);
    expect(desc).toEqual({method: 'foo', args: [1, 'two']});
    // Flush microtasks; auto-fire should have bailed because consumed=true.
    await Promise.resolve();
    expect(sent.calls).toBe(0);
  });

  it('claimForSync after a microtask elapses throws (auto-fire already won)', async () => {
    const sent = spy();
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: []},
      sent.fn,
    );
    await Promise.resolve();
    expect(sent.calls).toBe(1);
    expect(() => claimForSync(p)).toThrow(SyncRPCAlreadyWaitedError);
  });

  it('claimForSync after .then throws SyncRPCAlreadyWaitedError', () => {
    const sent = spy();
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: []},
      sent.fn,
    );
    void p.then(() => undefined);
    expect(() => claimForSync(p)).toThrow(SyncRPCAlreadyWaitedError);
  });

  it('claimForSync on a value that is not a SyncablePromise throws', () => {
    const fake = Promise.resolve(1) as never;
    expect(() => claimForSync(fake)).toThrow(SyncRPCAlreadyWaitedError);
  });

  it('.then after claimForSync does not re-fire asyncSend', async () => {
    const sent = spy();
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: []},
      sent.fn,
    );
    claimForSync(p);
    void p.then(() => undefined);
    await Promise.resolve();
    // No async send: sync claimed first; auto-fire microtask bailed.
    expect(sent.calls).toBe(0);
  });

  it('settleSyncable resolves a sync-claimed promise', async () => {
    const sent = spy();
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: []},
      sent.fn,
    );
    claimForSync(p);
    settleSyncable(p, {ok: true, value: 'hi'});
    expect(await p).toBe('hi');
  });

  it('settleSyncable rejects a sync-claimed promise', async () => {
    const sent = spy();
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: []},
      sent.fn,
    );
    claimForSync(p);
    settleSyncable(p, {ok: false, error: new Error('boom')});
    await expect(p).rejects.toThrow('boom');
  });

  it('settleSyncable throws if the promise was not claimed via claimForSync', () => {
    const sent = spy();
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: []},
      sent.fn,
    );
    expect(() => settleSyncable(p, {ok: true, value: 'hi'})).toThrow(/claimForSync/);
  });

  it('settleSyncable throws on a value that is not a SyncablePromise', () => {
    const fake = Promise.resolve(1) as never;
    expect(() => settleSyncable(fake, {ok: true, value: 1})).toThrow();
  });

  it('claimForSync twice throws SyncRPCAlreadyWaitedError', () => {
    const sent = spy();
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: []},
      sent.fn,
    );
    claimForSync(p);
    expect(() => claimForSync(p)).toThrow(SyncRPCAlreadyWaitedError);
  });

  it('.then result is a plain Promise (not SyncablePromiseImpl)', () => {
    const sent = spy();
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: []},
      sent.fn,
    );
    const chained = p.then((v) => v.toUpperCase());
    expect(chained).not.toBeInstanceOf(SyncablePromiseImpl);
    expect(chained).toBeInstanceOf(Promise);
  });

  it('isSyncablePromise narrows correctly', () => {
    const sent = spy();
    const p = new SyncablePromiseImpl<string>(
      {method: 'foo', args: []},
      sent.fn,
    );
    expect(isSyncablePromise(p)).toBe(true);
    expect(isSyncablePromise(Promise.resolve(1))).toBe(false);
    expect(isSyncablePromise(null)).toBe(false);
    expect(isSyncablePromise({then: () => undefined})).toBe(false);
  });

  it('constructor rejects bad invocation from static factories', () => {
    // `new SyncablePromiseImpl(executor)` (the inherited static shape)
    // must fail loudly rather than produce a half-built instance whose
    // auto-fire microtask leaks an unhandled rejection.
    expect(
      () =>
        new (SyncablePromiseImpl as unknown as new (
          x: unknown,
        ) => unknown)((res: () => void) => res()),
    ).toThrow(TypeError);
  });
});
