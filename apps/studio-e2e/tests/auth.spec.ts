/** ADR-0019 token transport: a wrong token is refused (4401) and the console says so. */
import { expect, test } from '../fixtures/test.js';

test('a wrong token gives the unauthorized screen, and the right one connects', async ({
  open,
  kernel,
}) => {
  const page = await open({}, `${kernel.server.url}/#token=not-the-right-token-123`);
  await expect(page.locator('.conn-unauthorized')).toHaveText(/Token refused/);
  const prompt = page.getByRole('dialog', { name: 'Connect to the KernelPAI kernel' });
  await expect(prompt).toBeVisible();
  await expect(page.getByRole('button', { name: 'Plan' })).toBeDisabled();
  // The refused token is not kept, and the fragment left the address bar.
  expect(await page.evaluate(() => sessionStorage.getItem('kp-studio.token'))).toBeNull();
  expect(new URL(page.url()).hash).toBe('');

  await prompt.getByLabel('Token').fill(kernel.server.token);
  await prompt.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.conn-open')).toBeVisible();
  await expect(prompt).toBeHidden();
});

test('without a token the console asks for one and does not connect', async ({ open, kernel }) => {
  const page = await open({}, `${kernel.server.url}/`);
  await expect(page.getByRole('dialog', { name: 'Connect to the KernelPAI kernel' })).toBeVisible();
  await expect(page.locator('.conn-idle')).toBeVisible();
});
