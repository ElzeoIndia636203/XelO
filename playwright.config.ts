import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 4173);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    env: {
      E2E_PORT: String(port),
    },
  },
});
