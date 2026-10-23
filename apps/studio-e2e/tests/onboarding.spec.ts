/** First run (spec §4.6, R-308, A-001): detected providers, a profile, a guided first task. */
import { connected, expect, test } from '../fixtures/test.js';

test('first run: providers, profile, $0 path and a guided first task', async ({ open }) => {
  const page = await open({ onboarded: false });
  const dialog = page.getByRole('dialog', { name: 'Welcome to KP Studio' });
  await expect(dialog).toBeVisible();
  await connected(page);

  // Detection: the four offline mocks are ready; the local probe (no Ollama) is not.
  for (const id of ['mock-alpha', 'mock-beta', 'mock-gamma', 'mock-delta'])
    await expect(dialog.getByText(`${id} (cloud, paid): ready`)).toBeVisible();
  await expect(dialog.getByText(/Ollama.*not available/)).toBeVisible();
  // No local model: the $0 path is offered but cannot be ticked, and says why.
  await expect(dialog.getByLabel('$0 path: local models only')).toBeDisabled();

  await expect(dialog.getByLabel('Balanced')).toBeChecked();
  await dialog.getByLabel('Economy').check();
  const task = dialog.getByLabel('First task');
  await expect(task).toHaveValue(/Explain what this project does/);
  await dialog.getByRole('button', { name: 'Plan this first task' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator('.plan-bar')).toBeVisible();
  await expect(page.locator('.plan-bar')).toContainText(/Estimate \$/);

  // The choice is kept: a reload goes straight to the console.
  const prefs = await page.evaluate(() => localStorage.getItem('kp-studio.prefs'));
  expect(JSON.parse(prefs ?? '{}')).toMatchObject({ onboarded: true, profile: 'economy' });
  await page.reload();
  await connected(page);
  await expect(page.getByRole('dialog', { name: 'Welcome to KP Studio' })).toHaveCount(0);
});

test('Skip closes the first-run screen for good', async ({ open }) => {
  const page = await open({ onboarded: false });
  const dialog = page.getByRole('dialog', { name: 'Welcome to KP Studio' });
  await connected(page);
  await dialog.getByRole('button', { name: 'Skip' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#command-input')).toBeVisible();
  await expect(page.locator('.plan-bar')).toHaveCount(0);
});
