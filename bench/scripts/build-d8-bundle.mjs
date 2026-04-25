import fs from 'node:fs/promises';
import path from 'node:path';
import {rollup} from 'rollup';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import sucrase from '@rollup/plugin-sucrase';

const outDir = path.resolve('bench/.tmp');
await fs.mkdir(outDir, {recursive: true});
const outFile = path.join(outDir, 'd8-bench.js');

const bundle = await rollup({
  input: path.resolve('bench/d8/entry.ts'),
  treeshake: true,
  plugins: [
    nodeResolve({browser: true, preferBuiltins: false}),
    commonjs(),
    sucrase({
      include: ['**/*.ts'],
      transforms: ['typescript'],
    }),
  ],
  onwarn(warning, warn) {
    if (warning.code === 'THIS_IS_UNDEFINED') return;
    warn(warning);
  },
});

await bundle.write({
  file: outFile,
  format: 'iife',
  name: 'MixedSignalsD8Bench',
});

await bundle.close();
console.log(outFile);
