import {defineConfig} from 'tsdown';

export default defineConfig({
  entry: {
    server: 'server/index.ts',
    client: 'client/index.ts',
  },
  format: 'esm',
  dts: true,
  // exports: true,
  outputOptions: {
    chunkFileNames: '[name].shared.js',
  },
  outDir: 'build',
  outExtensions: () => ({js: '.js', dts: '.d.ts'}),
});
