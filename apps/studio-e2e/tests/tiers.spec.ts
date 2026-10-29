/**
 * Simplicity Charter §3 tiers (finding P5-F5), end to end: the Beginner screen (the
 * default) shows the core jobs only and passes axe; a beginner meets the Enterprise view
 * through a program or "Delegate a whole project", and Stop everything is on screen
 * whenever a program runs, whatever the tier.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { openFake } from '../fixtures/enterprise.js';
import { connected, expect, test } from '../fixtures/test.js';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function serious(page: Page, screen: string): Promise<string[]> {
  const { violations, passes } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  console.log(`axe ${screen}: ${passes.length} rules passed, ${bad.length} serious/critical`);
  return bad.map((v) => `${screen}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

for (const theme of ['dark', 'light'] as const) {
  test(`beginner screen, ${theme} theme: core jobs only, 0 serious or critical`, async ({
    open,
  }) => {
    const page = await open({ theme });
    await connected(page);
    await expect(page.getByLabel('Level')).toHaveValue('beginner');
    await expect(page.locator('.view-switch')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Tools & skills' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Conversation' })).toBeVisible();
    // Alt+E does nothing without a program.
    await page.keyboard.press('Alt+e');
    await expect(page.locator('#ent-title')).toHaveCount(0);
    const found = await serious(page, `${theme}/beginner`);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('option', { name: /^Delegate a whole project/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /Enterprise view/ })).toHaveCount(0);
    found.push(...(await serious(page, `${theme}/beginner palette`)));
    expect(found).toEqual([]);
  });
}

test('a beginner delegates a whole project from the palette; the view then stays', async ({
  open,
  page,
}) => {
  await open();
  await connected(page);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Delegate a whole project');
  await page.keyboard.press('Enter');
  await expect(page.locator('#ent-title')).toBeFocused();
  await page.reload();
  await connected(page);
  await expect(page.getByRole('button', { name: 'Delegated projects' })).toBeVisible();
});

test('a beginner with a running program sees the view in plain words and Stop everything', async ({
  page,
}) => {
  const fake = await openFake(page);
  const views = page.locator('.view-switch');
  await expect(views.getByRole('button', { name: 'My tasks' })).toBeVisible();
  await expect(views.getByRole('button', { name: /^Delegated projects/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Tools & skills' })).toHaveCount(0);
  const found = await serious(page, 'beginner with a program');
  expect(found).toEqual([]);
  await page.getByRole('button', { name: 'Stop everything' }).click();
  await expect(page.getByRole('button', { name: 'Stop everything' })).toHaveCount(0);
  expect(fake.calls.filter((c) => c.method === 'enterprise.kill')).toHaveLength(1);
  // Departments stay an expert view.
  await page.keyboard.press('Alt+e');
  await page.locator('.gauges').waitFor();
  await expect(page.getByRole('button', { name: 'Departments (expert)' })).toHaveCount(0);
});

test('the tier is set from the header; Regular shows Tools and the Enterprise view', async ({
  open,
  page,
}) => {
  await open();
  await connected(page);
  await page.getByLabel('Level').selectOption('regular');
  await expect(page.getByRole('tab', { name: 'Tools & skills' })).toBeVisible();
  await expect(
    page.locator('.view-switch').getByRole('button', { name: 'Enterprise' }),
  ).toBeVisible();
  await page.reload();
  await connected(page);
  await expect(page.getByLabel('Level')).toHaveValue('regular');
});
