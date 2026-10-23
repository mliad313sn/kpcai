/** WI-S6-02 / A-008: French and English, switched live; `<html lang>` follows. */
import { CODE_REQUEST } from '../fixtures/kernel.js';
import { connected, expect, plan, test } from '../fixtures/test.js';

test('switches between English and French without a reload', async ({ open }) => {
  const page = await open();
  await connected(page);
  await plan(page, CODE_REQUEST);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.cost-band')).toContainText('Estimate');

  await page.getByLabel('Language').selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('button', { name: 'Planifier' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Exécutions' })).toBeVisible();
  await expect(page.locator('.cost-band')).toContainText('Estimation');
  await expect(page.locator('.cost-band')).toContainText('plafond');
  await page.locator('#node-architecture').click();
  await expect(page.getByRole('heading', { name: 'Pourquoi ce modèle' })).toBeVisible();
  // Kernel data (the router's reason) is never translated.
  await expect(page.locator('section.routing')).toContainText('mock-alpha/m1 for analysis');

  // The choice survives a reload, and the plan is still the one on screen until then.
  await page.reload();
  await connected(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await page.getByLabel('Langue').selectOption('en');
  await expect(page.getByRole('button', { name: 'Plan', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
