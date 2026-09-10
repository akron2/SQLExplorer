import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const external = [
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
  'electron',
  'oracledb',
  'pg',
  'pg-cursor',
];

export default defineConfig({
  build: {
    target: 'node24',
    outDir: '.vite/build',
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: 'src/main/main.ts',
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: { external },
  },
});
