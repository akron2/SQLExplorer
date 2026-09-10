import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/electron',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
