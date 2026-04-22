import {defineConfig} from 'tsdown';

export default defineConfig({
  entry: {
    server: 'server/index.ts',
    client: 'client/index.ts',
    codecs: 'codecs/index.ts',
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
