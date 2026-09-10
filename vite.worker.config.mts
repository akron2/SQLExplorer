import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node24',
    outDir: '.vite/build',
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: 'src/main/db-worker.ts',
      formats: ['cjs'],
      fileName: () => 'db-worker.js',
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((moduleName) => `node:${moduleName}`),
        'oracledb',
        'pg',
        'pg-cursor',
      ],
    },
  },
});
