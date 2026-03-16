import {defineConfig} from 'tsdown';

export default defineConfig({
  entry: {
    'server/index': 'server/index.ts',
    'client/index': 'client/index.ts',
  },
  format: 'esm',
  dts: true,
  outDir: 'build',
  outExtensions: () => ({js: '.js', dts: '.d.ts'}),
});
