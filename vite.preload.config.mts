import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node24',
    outDir: '.vite/build',
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: 'src/main/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.js',
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((moduleName) => `node:${moduleName}`),
        'electron',
      ],
    },
  },
});
