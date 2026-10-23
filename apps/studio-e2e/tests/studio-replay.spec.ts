/**
 * Replay, fork, grades and evidence (R-402, R-403, R-404, ADR-0028) in KP Studio against
 * the real kernel: a finished code run, a node replayed with another model beside the
 * original, a fork run like any plan, a manual grade, and the accuracy and competence view.
 */
import { CODE_REQUEST } from '../fixtures/kernel.js';
import { connected, expect, plan, test } from '../fixtures/test.js';

test('replay compare, fork, grade and the evidence view', async ({ open }) => {
  const page = await open();
  await connected(page);
  await plan(page, CODE_REQUEST);
  await page.getByRole('button', { name: /^Run/ }).click();
  await expect(page.locator('.graph .node.state-done')).toHaveCount(4, { timeout: 45_000 });
  // R-404: the run's verification ROI under the run bar.
  await expect(page.locator('.verification')).toContainText(/Verification: review \$/);

  // Replay the implementation with another model: both attempts side by side.
  await page.locator('#node-implementation').click();
  const detail = page.locator('aside.detail');
  await detail.getByRole('button', { name: 'Replay…' }).click();
  const replay = page.getByRole('dialog', { name: 'Replay node #implementation' });
  await expect(replay.getByRole('button', { name: 'Replay' })).toBeDisabled();
  await replay.getByLabel('Model').selectOption('mock-alpha/m1');
  await replay.getByRole('button', { name: 'Replay' }).click();
  const compare = detail.getByRole('region', { name: 'Replay beside the original' });
  await expect(compare).toBeVisible({ timeout: 45_000 });
  await expect(compare.getByRole('row', { name: /^Models/ })).toContainText('mock-alpha/m1');
  await expect(compare.getByRole('row', { name: /^Models/ })).toContainText('mock-beta/m1');
  await expect(compare.getByRole('row', { name: /^Verdicts/ })).toContainText('approved');
  await expect(compare).toContainText(/(Same|Different) output · cost/);
  await expect(compare.locator('.side-by-side pre')).toHaveCount(2);

  // Grade it: journaled with the user as author.
  await detail.getByLabel('Note (optional)').fill('clean and tested');
  await detail.getByRole('button', { name: /Good/ }).click();
  await expect(detail).toContainText(/You graded mock-beta\/m1 good\. Note: clean and tested/);

  // Accuracy & competence: the run is in the accuracy table, the grade in competence.
  await page.getByRole('tab', { name: 'Accuracy & competence' }).click();
  const acc = page.getByRole('region', { name: 'Estimate accuracy' });
  await expect(acc.getByRole('row', { name: /^All runs 1 / })).toBeVisible();
  const comp = page.getByRole('region', { name: 'Measured competence here' });
  await expect(comp).toContainText(/rated good 1\/1/);

  // Fork from the tests node with an instruction: a plan with its cap, then Run fork.
  await page.locator('#node-tests').click();
  await detail.getByRole('button', { name: 'Fork from here…' }).click();
  const fork = page.getByRole('dialog', { name: 'Fork from node #tests' });
  await fork.getByLabel('Instruction added to this node (optional)').fill('add an edge case');
  await fork.getByRole('button', { name: 'Plan the fork' }).click();
  const bar = page.locator('.plan-bar');
  await expect(bar).toContainText(/Fork of run .* from node #tests/);
  await expect(bar).toContainText(/Runs again: .*#tests/);
  await expect(bar).toContainText(/Reused as recorded, not billed again: .*#implementation/);
  await expect(page.locator('#node-implementation')).toContainText('reused');
  await page.getByRole('button', { name: /^Run fork \(cap / }).click();
  await expect(page.locator('.thread-bar .tag')).toContainText(/fork of .* from #tests/);
  await expect(page.locator('.thread-bar').getByText('done')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#node-implementation')).toContainText('done');
});
