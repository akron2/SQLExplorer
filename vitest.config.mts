import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    css: true,
    exclude: ['**/node_modules/**', 'tests/e2e/**', 'tests/electron/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/renderer/state/**/*.ts', 'src/renderer/editor/sql-selection.ts'],
    },
  },
});
