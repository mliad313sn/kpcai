/**
 * Enterprise view (R-5E10, R-5E11, S10 R8): live seat changes from the stream, and the
 * "answer an ask" flow with the keyboard only, where Approve unlocks only after the
 * evidence was opened. Driven by an in-page fake kernel (fixtures/enterprise.ts).
 */
import { expect, test } from '@playwright/test';
import { openFake, shot, showEnterprise } from '../fixtures/enterprise.js';

test('a seat changes state live, in words, and the summary follows', async ({ page }) => {
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs++;
    void d.dismiss();
  });
  const fake = await openFake(page);
  await showEnterprise(page);
  const card = page.locator('[data-seat-index]').filter({ hasText: 'Architect' }).first();
  await expect(card).toContainText('idle');
  const s4 = fake.snap.seats[4]!;
  fake.notify('enterprise.seat', { ...s4, state: 'blocked' });
  await expect(page.locator('.seat-card.seat-blocked').filter({ hasText: s4.title })).toBeVisible();
  await expect(page.locator('.ent-summary')).toContainText('2 blocked');
  // Untrusted text is text: the goal's markup never became an element.
  await expect(page.getByText('OAuth login <script>alert(1)</script> with tests')).toBeVisible();
  expect(dialogs).toBe(0);
});

test('answer an ask with the keyboard only: evidence first, then approve', async ({ page }) => {
  const fake = await openFake(page);
  await page.keyboard.press('Alt+e');
  await expect(page.locator('#ent-title')).toBeFocused();
  let presses = 1;
  const tabTo = async (name: RegExp) => {
    for (let i = 0; i < 80; i++) {
      const text = await page.evaluate(() => document.activeElement?.textContent ?? '');
      if (name.test(text)) return;
      await page.keyboard.press('Tab');
      presses++;
    }
    throw new Error(`never reached ${name}`);
  };
  await tabTo(/^Approve$/);
  const ask = page.getByRole('article', { name: 'Merge wp3 into <i>main</i>?' });
  const approve = ask.getByRole('button', { name: 'Approve' });
  await expect(approve).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  presses++;
  expect(fake.calls.filter((c) => c.method === 'program.answer')).toHaveLength(0);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  presses += 2;
  await expect(ask.getByRole('button', { name: /Open the evidence/ })).toBeFocused();
  await page.keyboard.press('Enter');
  presses++;
  await expect(ask.getByText('merge-default-branch')).toBeVisible();
  await expect(approve).toHaveAttribute('aria-disabled', 'false');
  await shot(page, 'enterprise-ask-evidence-open');
  await approve.focus();
  await page.keyboard.press('Enter');
  presses++;
  await expect(ask).toHaveCount(0);
  const methods = fake.calls.map((c) => c.method);
  expect(methods).toContain('program.viewed');
  expect(fake.calls.find((c) => c.method === 'program.answer')?.params).toMatchObject({
    escalationId: 'e-merge',
    answer: 'yes',
  });
  expect(methods.indexOf('program.viewed')).toBeLessThan(methods.indexOf('program.answer'));
  console.log(`keyboard-only "answer an ask": ${presses} key presses from the workspace`);
});

test('stop everything is one click; a program stop asks first', async ({ page }) => {
  const fake = await openFake(page);
  await showEnterprise(page);
  await page.getByRole('button', { name: 'Stop program p-auth' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Stop program p-auth?' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Stop everything' }).click();
  await expect(page.getByText('Everything is stopped')).toBeVisible();
  expect(fake.calls.filter((c) => c.method === 'enterprise.kill')).toHaveLength(1);
  expect(fake.calls.filter((c) => c.method === 'program.stop')).toHaveLength(0);
});

test('a stale heartbeat is loud, in French too', async ({ page }) => {
  await openFake(page, { heartbeatAgeSec: 2 * 3600, locale: 'fr' });
  await page.keyboard.press('Alt+e');
  const alert = page.getByRole('alert').filter({ hasText: 'silencieuse' });
  await expect(alert).toContainText('Le dernier battement date de 2 h 0 min');
  await shot(page, 'enterprise-stale-fr');
});
