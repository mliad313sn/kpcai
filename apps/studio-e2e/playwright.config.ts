/**
 * KP Studio end to end (phase 3, WP6): the built web console in Chromium against a real
 * kernel server with offline mock providers. Loopback only; no test touches the network.
 *
 * Browsers: Playwright's bundled Chromium (PLAYWRIGHT_BROWSERS_PATH, or `playwright install
 * chromium` in CI). KP_E2E_CHROMIUM points at another Chromium binary when the bundled
 * revision is missing.
 */
import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env['KP_E2E_CHROMIUM'];
const ci = !!process.env['CI'];

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results/artifacts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: ci,
  retries: 0,
  workers: ci ? 2 : 3,
  reporter: [['list'], ['json', { outputFile: './test-results/results.json' }]],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    trace: 'retain-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
});
