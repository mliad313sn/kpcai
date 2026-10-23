/**
 * The main path of KP Studio against the real kernel (R-301, R-302, R-304, R-305, R-307):
 * plan → edit a node's model → validate → run → live graph and agents → patches confirmed
 * with their diff → isolated run merged back → checkpoint restored after a confirmation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_REQUEST } from '../fixtures/kernel.js';
import { rpc, runEvents } from '../fixtures/rpc.js';
import { confirmDialog, connected, expect, plan, test } from '../fixtures/test.js';

test('plan, edit, validate, run, apply, merge and restore', async ({ open, kernel }) => {
  const page = await open();
  await connected(page);
  await plan(page, `${CODE_REQUEST} [[slow]]`);

  // R-301: pick another author model for the implementation; the kernel re-checks the edit.
  const impl = page.locator('#node-implementation');
  await expect(impl).toContainText('mock-beta/m1');
  await impl.click();
  const detail = page.locator('aside.detail');
  await expect(detail.getByRole('heading', { name: /#implementation/ })).toBeVisible();
  await detail.getByLabel('Model', { exact: true }).selectOption('mock-alpha/m1');
  await expect(impl).toContainText('mock-alpha/m1');
  await expect(impl).toContainText('your choice');
  await page.getByText('Your edits (1)').click();
  await expect(page.locator('.plan-check')).toContainText('model routed → mock-alpha/m1');
  const run = page.getByRole('button', { name: /^Run/ });
  await expect(run).toBeEnabled();
  await run.click();

  // Live graph and agents board while the slow mocks stream.
  await expect(page.locator('.graph .node.state-running').first()).toBeVisible();
  const agents = page.locator('table.agents tbody tr');
  await expect(agents.first()).toBeVisible();
  await expect(agents.first()).toContainText(/running/);
  await expect(page.locator('.graph .node.state-done')).toHaveCount(4, { timeout: 45_000 });

  // The journal shows the edited model ran the review node (R-301 acceptance).
  const r = await rpc(kernel.server.port, kernel.server.token);
  try {
    const { runs } = await r.call<{ runs: Array<{ runId: string; worktree?: string }> }>(
      'runs.list',
    );
    const runId = runs[0]!.runId;
    const worktree = runs[0]!.worktree!;
    expect(worktree.startsWith(kernel.home) || worktree.includes('worktrees')).toBe(true);
    const events = await runEvents(r, runId);
    // The routing entry records the edited plan, and the author call went to the chosen model.
    const routing = events.find((e) => e.type === 'routing');
    expect(JSON.stringify(routing?.payload)).toContain(
      '"id":"implementation","model":{"provider":"mock-alpha"',
    );
    const author = events.find(
      (e) => e.type === 'call' && e.nodeId === 'implementation' && e.payload['role'] === 'author',
    );
    expect(author?.provider).toBe('mock-alpha');

    // Patches: each one is confirmed with its exact diff, into the run's worktree.
    await page.getByRole('tab', { name: /Diff/ }).click();
    await page.getByRole('button', { name: /Apply all/ }).click();
    for (const file of ['src/s.ts', 'test/s.test.ts']) {
      const dialog = confirmDialog(page);
      await expect(dialog).toContainText(`diff --git a/${file}`);
      await dialog.getByRole('button', { name: 'Yes' }).click();
    }
    await expect(page.getByRole('button', { name: 'Applied' })).toHaveCount(2);
    expect(existsSync(join(worktree, 'src/s.ts'))).toBe(true);
    expect(existsSync(join(kernel.repo, 'src/s.ts'))).toBe(false);

    // R-307: merge the isolated run back, after a confirmation that shows the whole diff.
    await page.getByRole('tab', { name: 'Runs' }).click();
    const row = page.locator('table.runs tbody tr').first();
    await expect(row).toContainText('approved');
    await row.getByRole('button', { name: 'Merge' }).click();
    const merge = confirmDialog(page);
    await expect(merge).toContainText('diff --git a/src/s.ts');
    await merge.getByRole('button', { name: 'Yes' }).click();
    await expect.poll(() => existsSync(join(kernel.repo, 'src/s.ts'))).toBe(true);
    expect(readFileSync(join(kernel.repo, 'test/s.test.ts'), 'utf8').length).toBeGreaterThan(0);

    // R-305: restore the workspace checkpoint taken before the merge; destructive, confirmed.
    await row.getByRole('button', { name: 'Checkpoints' }).click();
    const cps = page.getByRole('list', { name: 'Checkpoints' });
    const beforeMerge = cps.getByRole('listitem').filter({ hasText: 'before merge' });
    await beforeMerge.getByRole('button', { name: 'Restore' }).click();
    const restore = confirmDialog(page);
    await expect(restore).toContainText(/destructive/i);
    // Default is No: focus starts on it.
    await expect(restore.getByRole('button', { name: 'No' })).toBeFocused();
    await restore.getByRole('button', { name: 'Yes' }).click();
    await expect.poll(() => existsSync(join(kernel.repo, 'src/s.ts'))).toBe(false);
    expect(readFileSync(join(kernel.repo, 'README.md'), 'utf8')).toBe('# e2e\n');
  } finally {
    r.close();
  }
});
