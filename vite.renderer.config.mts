import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'chrome142',
    outDir: '.vite/renderer/main_window',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: 'index.html',
    },
  },
  server: {
    strictPort: true,
  },
});
