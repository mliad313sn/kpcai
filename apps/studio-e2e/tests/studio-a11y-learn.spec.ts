/**
 * WCAG 2.2 AA with axe-core on the phase 4 screens of KP Studio, in the dark and the light
 * theme: memory editor and memory question, dispute dialog, replay dialog (choice, then its
 * estimate and inherited routing) and side-by-side compare with the grade box, fork plan, and the accuracy and competence view. Zero
 * serious or critical violations.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { CODE_REQUEST } from '../fixtures/kernel.js';
import { rpc } from '../fixtures/rpc.js';
import { confirmDialog, connected, expect, plan, test } from '../fixtures/test.js';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function audit(page: Page, screen: string): Promise<string[]> {
  const { violations, passes } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const theme = await page.locator('html').getAttribute('data-theme');
  const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const minor = violations.filter((v) => !bad.includes(v));
  console.log(
    `axe ${theme}/${screen}: ${passes.length} rules passed, ${bad.length} serious/critical, ` +
      `${minor.length} moderate/minor${minor.length ? ` (${minor.map((v) => v.id).join(', ')})` : ''}`,
  );
  return bad.map(
    (v) => `${screen}: ${v.id} — ${v.help} @ ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
}

const PROPOSING = [
  'summarize the architecture',
  '```memory',
  '- [project] Tests use vitest and sit next to sources',
  '```',
].join('\n');

const CHOICE =
  'which database should we use: redis or postgres? [[vote:redis@mock-alpha]] [[vote:postgres@mock-beta]] [[vote:sqlite@mock-gamma]] [[vote:mysql@mock-delta]]';

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test('memory editor, memory question and dispute dialog', async ({ open, kernel }) => {
      const page = await open({ theme });
      await connected(page);
      const found: string[] = [];
      await page.getByRole('tab', { name: /^Memory/ }).click();
      const project = page.getByRole('region', { name: 'Memory: project' });
      await project.getByLabel('Add a fact to project memory').fill('Use pnpm');
      await project.getByRole('button', { name: 'Add' }).click();
      await expect(project.locator('.facts')).toContainText('Use pnpm');
      const r = await rpc(kernel.server.port, kernel.server.token);
      await r.call('run.start', { request: PROPOSING, options: { isolated: false } });
      r.close();
      await expect(confirmDialog(page)).toContainText('Remember this fact?', { timeout: 45_000 });
      found.push(...(await audit(page, 'memory question')));
      await confirmDialog(page).getByRole('button', { name: 'Not now' }).click();
      await expect(page.getByRole('tab', { name: 'Memory (1)' })).toBeVisible();
      await project.getByRole('button', { name: 'Edit' }).click();
      found.push(...(await audit(page, 'memory editor with a proposal and an edit')));
      await page.getByRole('tab', { name: /^Memory/ }).click();
      await plan(page, CHOICE);
      await page.getByRole('button', { name: /^Run/ }).click();
      await expect(confirmDialog(page)).toContainText('reviewers disagree', { timeout: 45_000 });
      found.push(...(await audit(page, 'dispute dialog')));
      await page.keyboard.press('Escape');
      expect(found).toEqual([]);
    });

    test('replay, compare, grade, fork plan and evidence', async ({ open }) => {
      const page = await open({ theme });
      await connected(page);
      const found: string[] = [];
      await plan(page, CODE_REQUEST);
      await page.getByRole('button', { name: /^Run/ }).click();
      await expect(page.locator('.graph .node.state-done')).toHaveCount(4, { timeout: 45_000 });
      await page.locator('#node-implementation').click();
      const detail = page.locator('aside.detail');
      await detail.getByRole('button', { name: 'Replay…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Replay node #implementation' });
      await dialog.getByLabel('Model').selectOption('mock-alpha/m1');
      found.push(...(await audit(page, 'replay dialog')));
      await dialog.getByRole('button', { name: 'Estimate the replay' }).click();
      await expect(dialog.getByRole('region', { name: 'Before anything is spent' })).toBeVisible();
      found.push(...(await audit(page, 'replay dialog with its estimate and routing')));
      await dialog.getByRole('button', { name: /^Run replay/ }).click();
      await expect(detail.getByRole('region', { name: 'Replay beside the original' })).toBeVisible({
        timeout: 45_000,
      });
      await detail.getByRole('button', { name: /Good/ }).click();
      await expect(detail).toContainText(/You graded/);
      found.push(...(await audit(page, 'replay compare and grade')));
      await page.getByRole('tab', { name: 'Accuracy & competence' }).click();
      await expect(page.getByRole('region', { name: 'Estimate accuracy' })).toBeVisible();
      found.push(...(await audit(page, 'accuracy and competence')));
      await page.locator('#node-tests').click();
      await detail.getByRole('button', { name: 'Fork from here…' }).click();
      found.push(...(await audit(page, 'fork dialog')));
      await page.getByRole('button', { name: 'Plan the fork' }).click();
      await expect(page.locator('.fork-line')).toBeVisible();
      found.push(...(await audit(page, 'fork plan')));
      expect(found).toEqual([]);
    });
  });
}
