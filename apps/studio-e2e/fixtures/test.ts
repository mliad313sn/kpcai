/**
 * Playwright fixtures: every test gets its own kernel server (fresh $KPAI_HOME, fresh git
 * repository) and helpers to open KP Studio on it. Browser storage is per test context, so
 * preferences (theme, language, first run) never leak from one test to another.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { startKernel, type E2eKernel } from './kernel.js';

export interface Prefs {
  onboarded?: boolean;
  theme?: 'system' | 'dark' | 'light';
  locale?: 'system' | 'en' | 'fr';
}

export interface Fixtures {
  kernel: E2eKernel;
  /** Opens KP Studio with these preferences (default: onboarded, English, system theme). */
  open: (prefs?: Prefs, url?: string) => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  kernel: async ({}, use) => {
    const k = await startKernel();
    await use(k);
    await k.stop();
  },
  open: async ({ page, kernel }, use) => {
    await use(async (prefs = {}, url = kernel.url) => {
      const seeded = { onboarded: true, locale: 'en', ...prefs };
      await page.addInitScript((p) => {
        // Seed once: a reload must keep what the test changed since.
        if (!sessionStorage.getItem('kp-e2e.seeded')) {
          localStorage.setItem('kp-studio.prefs', JSON.stringify(p));
          sessionStorage.setItem('kp-e2e.seeded', '1');
        }
      }, seeded);
      await page.goto(url);
      return page;
    });
  },
});

export { expect };

/** Waits until the console is connected and the models are known. */
export async function connected(page: Page): Promise<void> {
  await expect(page.locator('.conn-open')).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Plan|Planifier)$/ })).toBeVisible();
}

/** Types a request in the command bar and waits for the proposed plan. */
export async function plan(page: Page, request: string): Promise<void> {
  const input = page.locator('#command-input');
  await input.fill(request);
  await input.press('Enter');
  await expect(page.locator('.plan-bar')).toBeVisible();
}

/** The confirmation dialog currently shown (tool, budget, patch, restore, artifact). */
export function confirmDialog(page: Page) {
  return page.getByRole('alertdialog');
}
