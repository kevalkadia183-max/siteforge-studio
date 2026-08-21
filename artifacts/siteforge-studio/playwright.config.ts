import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:80';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir:
    process.env.E2E_OUTPUT_DIR ?? join('test-results', process.pid.toString()),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'clerk-setup',
      testMatch: /clerk\.setup\.ts/,
    },
    {
      name: 'chromium',
      testIgnore: /clerk\.setup\.ts/,
      dependencies: ['clerk-setup'],
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});