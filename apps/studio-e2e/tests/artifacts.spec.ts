/**
 * D-019 / ADR-0022: non-code deliverables in the Artifacts tab. An unreviewed document is
 * marked, and saving it asks a confirmation that says "NOT REVIEWED" and shows the exact
 * content; No writes nothing, Yes writes it into the run's tree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPORT_REQUEST } from '../fixtures/kernel.js';
import { rpc } from '../fixtures/rpc.js';
import { confirmDialog, connected, expect, plan, test } from '../fixtures/test.js';

test('an unreviewed document is saved only after its own confirmation', async ({
  open,
  kernel,
}) => {
  const page = await open();
  await connected(page);
  await plan(page, REPORT_REQUEST);
  await page.getByRole('button', { name: /^Run/ }).click();
  await expect(page.locator('.thread-bar').getByText('done')).toBeVisible({ timeout: 45_000 });

  await page.getByRole('tab', { name: 'Artifacts' }).click();
  const gather = page.getByRole('article', { name: 'gather.md' });
  await expect(gather).toBeVisible();
  await expect(gather.getByText('not reviewed')).toBeVisible();
  await expect(gather.getByRole('list', { name: 'Provenance' })).toContainText('From node #gather');
  // The draft was reviewed by a critic from another provider: no warning on it.
  const draft = page.getByRole('article', { name: 'draft.md' });
  await expect(draft).toBeVisible();
  await expect(draft.getByText('not reviewed')).toHaveCount(0);

  const r = await rpc(kernel.server.port, kernel.server.token);
  const { runs } = await r
    .call<{ runs: Array<{ worktree?: string }> }>('runs.list')
    .finally(() => r.close());
  const tree = runs[0]?.worktree ?? kernel.repo;

  // No: nothing is written, the button stays available.
  await gather.getByRole('button', { name: 'Save…' }).click();
  let ask = confirmDialog(page);
  await expect(ask).toContainText('NOT REVIEWED');
  await expect(ask.getByRole('region', { name: /content/i })).toBeVisible();
  await expect(ask.getByRole('button', { name: 'No' })).toBeFocused();
  await ask.getByRole('button', { name: 'No' }).click();
  await expect(ask).toBeHidden();
  await expect(gather.getByRole('button', { name: 'Save…' })).toBeEnabled();
  expect(existsSync(join(tree, 'gather.md'))).toBe(false);

  // Yes: the exact content shown is what lands on disk.
  await gather.getByRole('button', { name: 'Save…' }).click();
  ask = confirmDialog(page);
  const shown = await ask.locator('pre.output').textContent();
  await ask.getByRole('button', { name: 'Yes' }).click();
  await expect(gather.getByRole('button', { name: '✓ Saved' })).toBeDisabled();
  expect(readFileSync(join(tree, 'gather.md'), 'utf8')).toBe(shown);
});
