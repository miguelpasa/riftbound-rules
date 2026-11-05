import { defineConfig, devices } from '@playwright/test';

const APP_PORT = 5173;
const PEER_PORT = 9000;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './e2e/global-setup.ts',
  outputDir: 'test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: [
    {
      command: 'npm run dev -w client',
      url: `http://localhost:${APP_PORT}`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      // Local PeerJS signalling server (the `peer` package) so tests never touch the public broker.
      command: `npx peerjs --port ${PEER_PORT} --path /`,
      url: `http://localhost:${PEER_PORT}/`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
