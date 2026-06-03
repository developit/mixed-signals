import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [
      '.ignore/**',
      'build/**',
      'node_modules/**',
    ],
    // Disabled in anticipation of future `worker_threads`-based sync
    // tests that spawn workers sharing real SAB lanes. Vitest's default
    // parallel-file mode would race those tests across separate
    // processes. Today's tests are pure unit-level (per-test
    // `allocateLane()`, no cross-file shared state) and would run fine
    // in parallel, but setting this here means later integration tests
    // don't need to touch the config.
    fileParallelism: false,
  },
});
