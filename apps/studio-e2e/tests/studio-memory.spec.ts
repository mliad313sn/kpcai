/**
 * Memory (ADR-0027) in KP Studio against the real kernel: a fact the user adds is trusted;
 * a fact a model proposes is asked about with its source, kept only on a yes, stays
 * untrusted, and then reaches the next plan.
 */
import { rpc } from '../fixtures/rpc.js';
import { connected, confirmDialog, expect, plan, test } from '../fixtures/test.js';

const PROPOSING = [
  'summarize the architecture',
  '```memory',
  '- [project] Tests use vitest and sit next to sources',
  '- [user] Prefers short answers',
  '```',
].join('\n');

test('add, edit, propose, confirm and see memory in the plan', async ({ open, kernel }) => {
  const page = await open();
  await connected(page);

  // Add and edit a fact by hand: trusted, with its provenance.
  await page.getByRole('tab', { name: /^Memory/ }).click();
  const project = page.getByRole('region', { name: 'Memory: project' });
  await project.getByLabel('Add a fact to project memory').fill('Use pnpm');
  await project.getByRole('button', { name: 'Add' }).click();
  await expect(project.locator('.facts')).toContainText('Use pnpm');
  await expect(project.locator('.facts')).toContainText('trusted');
  await expect(project.locator('.facts')).toContainText('from human');
  await project.getByRole('button', { name: 'Edit' }).click();
  await project.getByLabel('Fact text').fill('Use pnpm 10');
  await project.getByRole('button', { name: 'Save' }).click();
  await expect(project.locator('.facts')).toContainText('Use pnpm 10');
  await expect(project.locator('.facts')).toContainText(/edited on/);

  // A model proposes two facts: each is asked about, quoted, with its source. The command
  // bar is one line, so this multi-line request is started over the protocol; the console
  // gets the run's questions like any other.
  const r = await rpc(kernel.server.port, kernel.server.token);
  await r.call('run.start', { request: PROPOSING, options: { isolated: false } });
  r.close();
  const ask = confirmDialog(page);
  await expect(ask).toContainText('Remember this fact?', { timeout: 45_000 });
  const fact = ask.getByRole('region', { name: /Proposed for project memory/ });
  await expect(fact.locator('blockquote')).toHaveText('Tests use vitest and sit next to sources');
  await expect(fact).toContainText('untrusted');
  await expect(fact).toContainText(/run:/);
  // Default is "Not now" (the proposal stays pending).
  await expect(ask.getByRole('button', { name: 'Not now' })).toBeFocused();
  await ask.getByRole('button', { name: 'Keep' }).click();
  await expect(confirmDialog(page)).toContainText('Prefers short answers');
  await confirmDialog(page).getByRole('button', { name: 'Not now' }).click();
  await expect(confirmDialog(page)).toHaveCount(0);

  // The pending queue holds the second; the first is a kept, untrusted model fact.
  await page.getByRole('tab', { name: /^Memory/ }).click();
  await expect(page.getByRole('tab', { name: 'Memory (1)' })).toBeVisible();
  const pending = page.getByRole('region', { name: /Proposals waiting for you/ });
  await expect(pending).toContainText('Prefers short answers');
  const kept = project.locator('.facts li').filter({ hasText: 'Tests use vitest' });
  await expect(kept).toContainText('untrusted');
  await expect(kept).toContainText(/kept by you on/);
  await pending.getByRole('button', { name: 'Keep' }).click();
  await expect(pending).toContainText('No proposal waiting.');
  await expect(page.getByRole('region', { name: 'Memory: user' })).toContainText(
    'Prefers short answers',
  );

  // The next plan says what memory every node gets.
  await plan(page, 'summarize the architecture again');
  await expect(page.locator('.memory-line')).toContainText(
    /Memory: 3 facts sent to every node \(user 1, project 2\); 2 as untrusted data/,
  );
  await expect(page.locator('.plan-bar')).toContainText(/Estimate accuracy: past estimates here/);

  // Remove asks once more, then the fact is gone.
  await page.getByRole('tab', { name: /^Memory/ }).click();
  const mine = project.locator('.facts li').filter({ hasText: 'Use pnpm 10' });
  await mine.getByRole('button', { name: 'Remove' }).click();
  await mine.getByRole('button', { name: 'Yes, remove' }).click();
  await expect(project.locator('.facts')).not.toContainText('Use pnpm 10');
});
