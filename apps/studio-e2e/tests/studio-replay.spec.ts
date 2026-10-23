/**
 * Replay, fork, grades and evidence (R-402, R-403, R-404, ADR-0028) in KP Studio against
 * the real kernel: a finished code run, a node replayed with another model beside the
 * original — its likely cost, cap and inherited routing shown before anything is spent,
 * and cancellable while it runs (P4-F5, P4-F2) — a fork run like any plan, a manual
 * grade, and the accuracy and competence view.
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
  // P4-F12: revised verdicts head the ROI line, raw issues second.
  await expect(page.locator('.verification')).toContainText(
    /revised verdicts? · .* · raw issues raised: \d+/,
  );

  // Replay the implementation with another model: both attempts side by side.
  await page.locator('#node-implementation').click();
  const detail = page.locator('aside.detail');
  await detail.getByRole('button', { name: 'Replay…' }).click();
  const replay = page.getByRole('dialog', { name: 'Replay node #implementation' });
  const estimate = replay.getByRole('button', { name: 'Estimate the replay' });
  await expect(estimate).toBeDisabled();
  await replay.getByLabel('Model').selectOption('mock-alpha/m1');
  await estimate.click();
  // P4-F5: likely, cap and the routing the replay inherits, before anything is spent.
  const before = replay.getByRole('region', { name: 'Before anything is spent' });
  await expect(before).toContainText(/Estimate: likely \$[\d.]+ · at most \$[\d.]+ \(hard cap\)/);
  await expect(before).toContainText('No provider restriction from the original run.');
  await expect(before).toContainText('Routing profile: Balanced.');
  await expect(detail.getByRole('region', { name: 'Replay beside the original' })).toHaveCount(0);
  await replay.getByRole('button', { name: /^Run replay \(cap \$[\d.]+\)$/ }).click();
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

test('a replay is estimated first and can be cancelled while it runs', async ({ open }) => {
  const page = await open();
  await connected(page);
  // The slow mocks stream one word per 50 ms: the replay runs long enough to cancel it.
  await plan(page, `${CODE_REQUEST} [[slow]]`);
  await page.getByRole('button', { name: /^Run/ }).click();
  await expect(page.locator('.graph .node.state-done')).toHaveCount(4, { timeout: 45_000 });
  await page.locator('#node-implementation').click();
  const detail = page.locator('aside.detail');
  await detail.getByRole('button', { name: 'Replay…' }).click();
  const replay = page.getByRole('dialog', { name: 'Replay node #implementation' });
  await replay.getByLabel('Protocol').selectOption('solo');
  await replay.getByRole('button', { name: 'Estimate the replay' }).click();
  await expect(replay.getByRole('region', { name: 'Before anything is spent' })).toContainText(
    /at most \$[\d.]+ \(hard cap\)/,
  );
  // A new choice drops the estimate: what runs is what was shown.
  await replay.getByLabel('Protocol').selectOption('author_critic');
  await expect(replay.getByRole('region', { name: 'Before anything is spent' })).toHaveCount(0);
  await replay.getByRole('button', { name: 'Estimate the replay' }).click();
  await replay.getByRole('button', { name: /^Run replay \(cap / }).click();
  await expect(detail.getByText('Replaying #implementation…')).toBeVisible();
  await detail.getByRole('button', { name: 'Cancel replay' }).click();
  const live = page.locator('[role="status"][aria-live="polite"]').first();
  await expect(detail.getByText('Replaying #implementation…')).toHaveCount(0, { timeout: 30_000 });
  // Cancelled, not failed and not finished: the live region says so last.
  await expect(live).toHaveText('Replay of node implementation cancelled');
  await expect(detail.getByRole('button', { name: 'Replay…' })).toBeEnabled();
});
