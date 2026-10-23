/**
 * Disputes (R-405) in KP Studio against the real kernel: three mock voters pick three
 * different answers, the node shows "disputed" and the human settles it. Picking an option
 * makes the node succeed with that answer; Escape (or Reject, or the timeout) fails closed.
 */
import { connected, confirmDialog, expect, plan, test } from '../fixtures/test.js';

const VOTES = [
  '[[vote:redis@mock-alpha]]',
  '[[vote:postgres@mock-beta]]',
  '[[vote:sqlite@mock-gamma]]',
  '[[vote:mysql@mock-delta]]',
].join(' ');
const CHOICE = `which database should we use: redis or postgres? ${VOTES}`;

async function disputed(page: import('@playwright/test').Page) {
  await plan(page, CHOICE);
  await page.getByRole('button', { name: /^Run/ }).click();
  const dialog = confirmDialog(page);
  await expect(dialog).toContainText('reviewers disagree', { timeout: 45_000 });
  return dialog;
}

test('choose: the picked answer becomes the node output', async ({ open }) => {
  const page = await open();
  await connected(page);
  const dialog = await disputed(page);
  await expect(dialog.getByRole('button', { name: 'Reject all' })).toBeFocused();
  await expect(dialog).toContainText(/no majority among 3 voters/);
  await expect(dialog).toContainText('model output, quoted as data');
  // The node waits in a "disputed" state.
  await expect(page.locator('#node-choice')).toContainText('disputed');
  const choose = dialog.getByRole('button', { name: 'Choose this answer' });
  await expect(choose).toBeDisabled();
  // Keyboard only: Shift+Tab from Reject into the options (the last one), Space picks it,
  // an arrow moves the pick, Tab Tab reaches Choose, Enter sends it.
  await expect(dialog.getByRole('radio')).toHaveCount(3);
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('radio', { name: /sqlite/ })).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await expect(dialog.getByRole('radio', { name: /postgres/ })).toBeChecked();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(choose).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(page.locator('.thread-bar').getByText('done')).toBeVisible({ timeout: 45_000 });
  await page.locator('#node-choice').click();
  const detail = page.locator('aside.detail');
  await expect(detail).toContainText(/Dispute settled by you: postgres/);
  await expect(page.getByRole('tabpanel')).toContainText('postgres');
  await expect(page.locator('.control-log')).toContainText(/Dispute on #choice/);
});

test('reject: Escape fails the node closed', async ({ open }) => {
  const page = await open();
  await connected(page);
  const dialog = await disputed(page);
  await dialog.getByRole('radio', { name: /sqlite/ }).check();
  await page.keyboard.press('Escape');
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(page.locator('.thread-bar').getByText('failed')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#node-choice')).toContainText('failed');
  await page.locator('#node-choice').click();
  await expect(page.locator('aside.detail')).toContainText(
    /Dispute rejected: the node failed with no output/,
  );
});
