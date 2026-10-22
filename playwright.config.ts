import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
const chromiumPath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'], launchOptions: { executablePath: chromiumPath, args: ['--no-sandbox'] } },
  webServer: {
    command: 'node scripts/reset-e2e.mjs && npm run db:seed && npm run dev -- --port 3100',
    url: 'http://127.0.0.1:3100',
    timeout: 120000,
    reuseExistingServer: false,
    env: { DATABASE_URL: '', LOCAL_DATABASE: 'true', DEMO_MODE: 'true', LOCAL_DATABASE_PATH: '.local/e2e-data', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-e2e' },
  },
});
