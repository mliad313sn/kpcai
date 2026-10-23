/**
 * WCAG 2.2 AA with axe-core (spec §4.5, A-012): zero serious or critical violations on the
 * main screens of KP Studio, in the dark and in the light theme.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { CODE_REQUEST, REPORT_REQUEST } from '../fixtures/kernel.js';
import { confirmDialog, connected, expect, plan, test } from '../fixtures/test.js';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface Finding {
  screen: string;
  id: string;
  impact: string;
  help: string;
  targets: string[];
}

/** Serious and critical violations of one screen, as plain data for a readable failure. */
async function audit(page: Page, screen: string): Promise<Finding[]> {
  const { violations, passes } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const theme = await page.locator('html').getAttribute('data-theme');
  const minor = violations.filter((v) => v.impact !== 'serious' && v.impact !== 'critical');
  // Evidence for the phase report: what axe checked, and what it found below "serious".
  console.log(
    `axe ${theme}/${screen}: ${passes.length} rules passed, ${violations.length - minor.length} serious/critical, ` +
      `${minor.length} moderate/minor${minor.length ? ` (${minor.map((v) => v.id).join(', ')})` : ''}`,
  );
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      screen,
      id: v.id,
      impact: v.impact ?? '',
      help: v.help,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
    }));
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test('first run, empty console, palette and token screens', async ({ open, kernel }) => {
      const page = await open({ onboarded: false, theme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await connected(page);
      const found: Finding[] = [];
      await expect(page.getByRole('dialog', { name: 'Welcome to KP Studio' })).toBeVisible();
      found.push(...(await audit(page, 'onboarding')));
      await page.getByRole('button', { name: 'Skip' }).click();
      found.push(...(await audit(page, 'empty console')));
      await page.keyboard.press('Control+k');
      await expect(page.locator('.palette')).toBeVisible();
      found.push(...(await audit(page, 'palette')));
      await page.keyboard.press('Escape');
      // A fresh tab: a fragment-only navigation would not reload the console.
      const refused = await page.context().newPage();
      await refused.goto(`${kernel.server.url}/#token=wrong-token-0000`);
      await expect(refused.locator('.conn-unauthorized')).toBeVisible();
      await expect(refused.locator('html')).toHaveAttribute('data-theme', theme);
      found.push(...(await audit(refused, 'token refused')));
      expect(found).toEqual([]);
    });

    test('plan, run, diff, confirmation and runs manager', async ({ open }) => {
      const page = await open({ theme });
      await connected(page);
      const found: Finding[] = [];
      await plan(page, `${CODE_REQUEST} [[slow]]`);
      await page.locator('#node-implementation').click();
      await expect(page.locator('aside.detail')).toBeVisible();
      found.push(...(await audit(page, 'plan with node detail')));
      await page.getByRole('button', { name: /^Run/ }).click();
      await expect(page.locator('table.agents tbody tr').first()).toBeVisible();
      found.push(...(await audit(page, 'live run with agents board')));
      await expect(page.locator('.graph .node.state-done')).toHaveCount(4, { timeout: 45_000 });
      found.push(...(await audit(page, 'finished run')));
      await page.getByRole('tab', { name: /Diff/ }).click();
      found.push(...(await audit(page, 'diff tab')));
      await page.getByRole('button', { name: /Apply all/ }).click();
      await expect(confirmDialog(page)).toBeVisible();
      found.push(...(await audit(page, 'patch confirmation')));
      for (let i = 0; i < 2; i++)
        await confirmDialog(page).getByRole('button', { name: 'Yes' }).click();
      await page.getByRole('tab', { name: 'Runs' }).click();
      const row = page.locator('table.runs tbody tr').first();
      await row.getByRole('button', { name: 'Checkpoints' }).click();
      await expect(page.getByRole('list', { name: 'Checkpoints' })).toBeVisible();
      found.push(...(await audit(page, 'runs manager with checkpoints')));
      expect(found).toEqual([]);
    });

    test('artifacts tab and an unreviewed save confirmation', async ({ open }) => {
      const page = await open({ theme });
      await connected(page);
      await plan(page, REPORT_REQUEST);
      await page.getByRole('button', { name: /^Run/ }).click();
      await expect(page.locator('.thread-bar').getByText('done')).toBeVisible({
        timeout: 45_000,
      });
      await page.getByRole('tab', { name: 'Artifacts' }).click();
      const found = await audit(page, 'artifacts tab');
      await page
        .getByRole('article', { name: 'gather.md' })
        .getByRole('button', { name: 'Save…' })
        .click();
      await expect(confirmDialog(page)).toContainText('NOT REVIEWED');
      found.push(...(await audit(page, 'unreviewed artifact confirmation')));
      expect(found).toEqual([]);
    });
  });
}
