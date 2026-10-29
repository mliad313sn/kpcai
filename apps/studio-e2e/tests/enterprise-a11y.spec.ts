/**
 * WCAG 2.2 AA on the Enterprise view and the Tools & skills tab (R-5E11, S10 R12): axe
 * finds zero serious or critical violations on every panel, in the dark and light themes,
 * and with reduced motion nothing moves. Screenshots go to KP_E2E_SHOTS when it is set.
 */
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openFake, shot, showEnterprise } from '../fixtures/enterprise.js';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface Finding {
  screen: string;
  id: string;
  impact: string;
  targets: string[];
}

async function audit(page: Page, screen: string): Promise<Finding[]> {
  const { violations, passes } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const theme = await page.locator('html').getAttribute('data-theme');
  const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const minor = violations.filter((v) => !bad.includes(v));
  console.log(
    `axe ${theme}/${screen}: ${passes.length} rules passed, ${bad.length} serious/critical, ` +
      `${minor.length} moderate/minor${minor.length ? ` (${minor.map((v) => v.id).join(', ')})` : ''}`,
  );
  return bad.map((v) => ({
    screen,
    id: v.id,
    impact: v.impact ?? '',
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
  }));
}

for (const theme of ['dark', 'light'] as const) {
  test(`Enterprise view, ${theme} theme: 0 serious or critical`, async ({ page }) => {
    // Expert: the departments view is audited too (Simplicity Charter §3).
    await openFake(page, { theme, tier: 'expert' });
    await showEnterprise(page);
    const found = await audit(page, 'enterprise overview');
    await shot(page, `enterprise-${theme}`);
    await page.getByRole('button', { name: 'Departments (expert)' }).click();
    found.push(...(await audit(page, 'departments')));
    await shot(page, `enterprise-departments-${theme}`);
    await page.locator('[data-seat-index="0"]').click();
    found.push(...(await audit(page, 'seat details')));
    await page.getByRole('button', { name: /Open the evidence/ }).click();
    found.push(...(await audit(page, 'ask with evidence')));
    await page.getByRole('button', { name: 'Review them' }).click();
    found.push(...(await audit(page, 'batch of trivial asks')));
    await page.getByRole('tab', { name: 'Activity' }).click();
    await expect(page.getByRole('feed')).toBeVisible();
    found.push(...(await audit(page, 'activity feed')));
    await shot(page, `enterprise-activity-${theme}`);
    await page.getByRole('tab', { name: 'Reports' }).click();
    found.push(...(await audit(page, 'reports archive')));
    await page.getByRole('button', { name: 'Stop program p-auth' }).click();
    found.push(...(await audit(page, 'stop confirmation')));
    await page.keyboard.press('Escape');
    expect(found).toEqual([]);
  });

  test(`Tools & skills tab and stale heartbeat, ${theme} theme`, async ({ page }) => {
    // Regular: the first tier that shows the Tools & skills tab.
    await openFake(page, { theme, heartbeatAgeSec: 3600, tier: 'regular' });
    await page.getByRole('tab', { name: 'Tools & skills' }).click();
    await expect(page.getByRole('article', { name: 'gh' })).toBeVisible();
    const found = await audit(page, 'tools & skills');
    await shot(page, `tools-${theme}`);
    await showEnterprise(page);
    await expect(page.getByRole('alert').filter({ hasText: 'gone silent' })).toBeVisible();
    found.push(...(await audit(page, 'stale heartbeat')));
    await shot(page, `enterprise-stale-${theme}`);
    expect(found).toEqual([]);
  });
}

test('reduced motion: nothing in the Enterprise view animates', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openFake(page);
  await showEnterprise(page);
  const moving = await page.evaluate(
    () =>
      [...document.querySelectorAll('.enterprise *')].filter((el) => {
        const s = getComputedStyle(el);
        const anim = s.animationName !== 'none' && s.animationDuration !== '0s';
        const trans = s.transitionDuration.split(',').some((d) => parseFloat(d) > 0.01);
        return anim || trans;
      }).length,
  );
  expect(moving).toBe(0);
});
