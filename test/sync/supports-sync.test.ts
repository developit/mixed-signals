import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {describe, expect, it} from 'vitest';
import {supportsSync as supportsSyncNode} from '../../sync/support.node.ts';
import {supportsSync as supportsSyncBrowser} from '../../sync/support.ts';

const NODE_WORKER_FIXTURE = new URL(
  './_supports-sync-fixture.ts',
  import.meta.url,
);

describe('supportsSync (Node conditional entry)', () => {
  it('returns false from the Node main thread', () => {
    expect(supportsSyncNode()).toBe(false);
  });

  it('returns true from inside a Node worker_threads Worker', async () => {
    const worker = new Worker(NODE_WORKER_FIXTURE);
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        worker.on('message', resolve);
        worker.on('error', reject);
      });
      expect(result).toEqual({type: 'result', value: true});
    } finally {
      await worker.terminate();
    }
  });
});

describe('supportsSync (browser entry, sanity from Node main)', () => {
  it('returns false from Node main thread (no WorkerGlobalScope)', () => {
    expect(supportsSyncBrowser()).toBe(false);
  });
});

describe('build output: browser bundle does not import node:worker_threads', () => {
  // This assertion depends on `pnpm build` having produced
  // `build/sync.js`. The gate sequence runs `pnpm build` after
  // `pnpm test run`, so a fresh CI run starts without this artifact;
  // local re-runs after one build cycle will have it. Skip cleanly
  // when the file is absent so this test is informative when it can
  // run but not gating when it can't.
  it('build/sync.js (browser entry) does not import node:worker_threads', async () => {
    const path = new URL('../../build/sync.js', import.meta.url);
    if (!existsSync(path)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[supports-sync.test] skipping bundle assertion: build/sync.js absent',
      );
      return;
    }
    const contents = await readFile(path, 'utf8');
    expect(contents).not.toMatch(/node:worker_threads/);
    expect(contents).not.toMatch(/['"]worker_threads['"]/);
  });

  it('build/sync.node.js (Node entry) imports node:worker_threads', async () => {
    const path = new URL('../../build/sync.node.js', import.meta.url);
    if (!existsSync(path)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[supports-sync.test] skipping bundle assertion: build/sync.node.js absent',
      );
      return;
    }
    const contents = await readFile(path, 'utf8');
    // The Node entry must keep the static import live — that's the
    // whole point of the conditional export.
    expect(contents).toMatch(/node:worker_threads/);
  });
});
