import {describe, expect, it} from 'vitest';
import * as sync from '../../sync/index.ts';

/**
 * The public surface of `mixed-signals/sync` is small and high-stakes.
 * This test pins the runtime export shape so an accidental
 * `export * from './lane.ts'` (or similar) fails loudly before reaching
 * a published bundle.
 */
describe('mixed-signals/sync public surface', () => {
  const EXPECTED_PUBLIC_RUNTIME_EXPORTS = [
    'SyncRPCAlreadyWaitedError',
    'SyncRPCError',
    'SyncRPCIframeBridgeError',
    'SyncRPCNoTransportWaitError',
    'SyncRPCNotCrossOriginIsolatedError',
    'SyncRPCPayloadTooLargeError',
    'SyncRPCReentrancyError',
    'SyncRPCTimeoutError',
    'SyncRPCUnsupportedContextError',
    'supportsSync',
  ];

  it('exposes exactly the documented runtime exports', () => {
    expect(Object.keys(sync).sort()).toEqual(
      [...EXPECTED_PUBLIC_RUNTIME_EXPORTS].sort(),
    );
  });

  it('does not expose internal lane / promise helpers at runtime', () => {
    const surface = sync as unknown as Record<string, unknown>;
    for (const internal of [
      'CTRL',
      'LANE_STATE',
      'CHUNK_STATE',
      'CALLER_STATE',
      'WIRE_TYPE',
      'CONTROL_SAB_BYTES',
      'DEFAULT_DATA_SAB_BYTES',
      'MAX_DATA_SAB_BYTES',
      'MIN_DATA_SAB_BYTES',
      'LANE_VERSION',
      'allocateLane',
      'loadCtrl',
      'storeCtrl',
      'claimForSync',
      'settleSyncable',
      'isSyncablePromise',
      'SyncablePromiseImpl',
      'SyncableCallDescriptor',
    ]) {
      expect(surface[internal]).toBeUndefined();
    }
  });

  it('does not expose SyncablePromise as a runtime value', () => {
    // `SyncablePromise` is a public TYPE, not a constructible value.
    // Consumers reference it for type annotations; they cannot
    // `new SyncablePromise(...)` or call `SyncablePromise.resolve(...)`.
    const surface = sync as unknown as Record<string, unknown>;
    expect(surface.SyncablePromise).toBeUndefined();
  });

  it('every exposed error class extends SyncRPCError', () => {
    const {SyncRPCError} = sync;
    for (const name of EXPECTED_PUBLIC_RUNTIME_EXPORTS) {
      if (!name.startsWith('SyncRPC')) continue;
      const Cls = (sync as unknown as Record<string, unknown>)[name] as
        | (new (msg?: string) => Error)
        | undefined;
      expect(Cls).toBeDefined();
      const instance = new Cls!('msg');
      expect(instance).toBeInstanceOf(SyncRPCError);
      expect(instance).toBeInstanceOf(Error);
      expect(instance.name).toBe(name);
    }
  });
});
