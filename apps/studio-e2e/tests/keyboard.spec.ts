/**
 * Spec §4.5 "keyboard first": the main path with the keyboard only — no click, no mouse.
 * Plan, edit a node's model, run, apply the patches, merge the isolated run, restore.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { CODE_REQUEST } from '../fixtures/kernel.js';
import { confirmDialog, connected, expect, test } from '../fixtures/test.js';

/** Presses Tab (or Shift+Tab) until `target` has the focus; fails after `max` presses. */
async function tabTo(page: Page, target: Locator, max = 80, back = false): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
  }
  await expect(target).toBeFocused();
}

/** A confirmation: focus starts on No; Tab moves to Yes; Enter answers. */
async function confirmYes(page: Page, expected: RegExp | string): Promise<void> {
  const dialog = confirmDialog(page);
  await expect(dialog).toContainText(expected);
  await expect(dialog.getByRole('button', { name: 'No' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Yes' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
}

/** Ctrl+K, a query, Enter: the palette's first match runs. */
async function palette(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox', { name: /Search/ })).toBeFocused();
  await page.keyboard.type(query);
  await page.keyboard.press('Enter');
}

test('the main path with the keyboard only', async ({ open, kernel }) => {
  const page = await open();
  await connected(page);

  // `/` focuses the command bar from anywhere.
  await page.locator('body').press('/');
  await expect(page.locator('#command-input')).toBeFocused();
  await page.keyboard.type(`${CODE_REQUEST} [[slow]]`);
  await page.keyboard.press('Enter');
  await expect(page.locator('.plan-bar')).toBeVisible();

  // Alt+5 jumps to the execution thread; Tab reaches a node; Enter opens its detail.
  await page.keyboard.press('Alt+5');
  await tabTo(page, page.locator('#node-architecture'));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  const impl = page.locator('#node-implementation');
  await expect(impl).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('aside.detail')).toBeVisible();

  // Edit the model with the keyboard (the select's type-ahead).
  const model = page.locator('#edit-model');
  await tabTo(page, model);
  await page.keyboard.type('mock-al');
  await expect(model).toHaveValue('mock-alpha/m1');
  await expect(impl).toContainText('your choice');

  const run = page.getByRole('button', { name: /^Run/ });
  await expect(run).toBeEnabled();
  await tabTo(page, run, 80, true);
  await page.keyboard.press('Enter');
  await expect(page.locator('.graph .node.state-done')).toHaveCount(4, { timeout: 45_000 });

  // Palette → Diff tab → Apply all → two confirmations answered from the keyboard.
  await palette(page, 'Go to Diff');
  await expect(page.getByRole('tab', { name: /Diff/ })).toHaveAttribute('aria-selected', 'true');
  await tabTo(page, page.getByRole('button', { name: /Apply all/ }));
  await page.keyboard.press('Enter');
  await confirmYes(page, 'diff --git a/src/s.ts');
  await confirmYes(page, 'diff --git a/test/s.test.ts');
  await expect(page.getByRole('button', { name: 'Applied' })).toHaveCount(2);

  // Runs tab with the tab list's arrow keys, merge and restore.
  await page.getByRole('tab', { name: /Diff/ }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
  const row = page.locator('table.runs tbody tr').first();
  await tabTo(page, row.getByRole('button', { name: 'Merge' }));
  await page.keyboard.press('Enter');
  await confirmYes(page, 'diff --git a/src/s.ts');
  await expect.poll(() => existsSync(join(kernel.repo, 'src/s.ts'))).toBe(true);

  await tabTo(page, row.getByRole('button', { name: 'Checkpoints' }), 80, true);
  await page.keyboard.press('Enter');
  const restore = page
    .getByRole('list', { name: 'Checkpoints' })
    .getByRole('listitem')
    .filter({ hasText: 'before merge' })
    .getByRole('button', { name: 'Restore' });
  await tabTo(page, restore);
  await page.keyboard.press('Enter');
  await confirmYes(page, /destructive/i);
  await expect.poll(() => existsSync(join(kernel.repo, 'src/s.ts'))).toBe(false);

  // Escape closes the palette without doing anything.
  await page.keyboard.press('Control+k');
  await expect(page.locator('.palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.palette')).toHaveCount(0);
});
