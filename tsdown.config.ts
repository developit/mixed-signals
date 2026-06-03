import {defineConfig} from 'tsdown';

export default defineConfig({
  entry: {
    server: 'server/index.ts',
    client: 'client/index.ts',
    codecs: 'codecs/index.ts',
    sync: 'sync/index.ts',
    'sync.node': 'sync/index.node.ts',
  },
  format: 'esm',
  dts: true,
  minify: true,
  outputOptions: {
    chunkFileNames: '[name].shared.js',
  },
  outDir: 'build',
  outExtensions: () => ({js: '.js', dts: '.d.ts'}),
});
