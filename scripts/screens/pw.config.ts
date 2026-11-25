import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 4173);
const root = resolve(import.meta.dirname, '../..');

export default defineConfig({
  testDir: '.',
  testMatch: 'screens.spec.ts',
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `node "${resolve(root, 'tests/e2e/server.mjs')}"`,
    cwd: root,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    env: {
      E2E_PORT: String(port),
    },
  },
});
