import {describe, expect, it} from 'vitest';
import * as syncNode from '../../sync/index.node.ts';
import * as syncBrowser from '../../sync/index.ts';

/**
 * The Node-conditional entry (`./sync` with the `node` condition)
 * must expose the same public surface as the browser-default entry.
 * Only `supportsSync` may differ in implementation; the rest comes
 * from shared modules. Drift between the two surfaces would split
 * the package's public API based on which runtime the consumer is
 * on — a subtle and easy-to-miss bug.
 */
describe('mixed-signals/sync — Node entry parity with browser entry', () => {
  it('exposes the same set of runtime export keys', () => {
    expect(Object.keys(syncNode).sort()).toEqual(
      Object.keys(syncBrowser).sort(),
    );
  });

  it('shares the error-class identities across entries', () => {
    // Every error class is sourced from `./errors.ts`, so the two
    // entries must reference the same constructor objects. If they
    // diverge, `instanceof` checks across runtime boundaries break.
    for (const name of Object.keys(syncBrowser)) {
      if (!name.startsWith('SyncRPC')) continue;
      const a = (syncBrowser as unknown as Record<string, unknown>)[name];
      const b = (syncNode as unknown as Record<string, unknown>)[name];
      expect(b).toBe(a);
    }
  });

  it('shares non-error wrappers across entries', () => {
    for (const name of [
      'enableSyncServer',
      'enableSyncClient',
      'createIframeRelayBridge',
      'createIframeBrokerBridge',
      'wrapWindowPostMessage',
      'wrapMessagePort',
    ]) {
      const a = (syncBrowser as unknown as Record<string, unknown>)[name];
      const b = (syncNode as unknown as Record<string, unknown>)[name];
      expect(b).toBe(a);
    }
  });

  it('uses a different supportsSync implementation than the browser entry', () => {
    expect(syncNode.supportsSync).not.toBe(syncBrowser.supportsSync);
  });
});
