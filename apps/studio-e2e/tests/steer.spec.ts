/** R-304 from the UI: pause, add an instruction to a pending node, resume; redirect a node. */
import { CODE_REQUEST } from '../fixtures/kernel.js';
import { rpc, runEvents } from '../fixtures/rpc.js';
import { connected, expect, plan, test } from '../fixtures/test.js';

test('pause, instruct a pending node, resume; finished work is kept', async ({ open, kernel }) => {
  const page = await open();
  await connected(page);
  await plan(page, `${CODE_REQUEST} [[slow]]`);
  await page.getByRole('button', { name: /^Run/ }).click();
  const controls = page.locator('.thread-bar').getByRole('group', { name: 'Run controls' });
  await expect(page.locator('#node-architecture.state-running')).toBeVisible();
  await controls.getByRole('button', { name: 'Pause' }).click();
  await expect(page.locator('.thread-bar').getByText('paused')).toBeVisible();
  // In-flight work finishes; nothing new starts while paused.
  await expect(page.locator('#node-architecture.state-done')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  await expect(page.locator('#node-implementation.state-running')).toHaveCount(0);

  await page.locator('#node-review').click();
  const box = page.getByRole('form', { name: 'Add an instruction' });
  await box.getByRole('textbox').fill('mention the token expiry');
  await box.getByRole('button', { name: 'Add instruction' }).click();
  await expect(page.getByRole('region', { name: 'Steering' })).toContainText(/instruction/i);

  await controls.getByRole('button', { name: 'Resume' }).click();
  await expect(page.locator('.graph .node.state-done')).toHaveCount(4, { timeout: 45_000 });

  const r = await rpc(kernel.server.port, kernel.server.token);
  try {
    const { runs } = await r.call<{ runs: Array<{ runId: string }> }>('runs.list');
    const events = await runEvents(r, runs[0]!.runId);
    const actions = events
      .filter((e) => e.type === 'intervention')
      .map((e) => String(e.payload['action']));
    expect(actions.join(' ')).toMatch(/pause/);
    expect(actions.join(' ')).toMatch(/instruction/);
    expect(actions.join(' ')).toMatch(/resume/);
    const reviewCall = events.find(
      (e) => e.type === 'call' && e.nodeId === 'review' && JSON.stringify(e.payload).length > 0,
    );
    expect(reviewCall).toBeDefined();
  } finally {
    r.close();
  }
});

test('redirect a running node to another model from the node detail', async ({ open }) => {
  const page = await open();
  await connected(page);
  await plan(page, `${CODE_REQUEST} [[slow]]`);
  await page.getByRole('button', { name: /^Run/ }).click();
  const controls = page.locator('.thread-bar').getByRole('group', { name: 'Run controls' });
  await expect(page.locator('#node-architecture.state-running')).toBeVisible();
  await controls.getByRole('button', { name: 'Pause' }).click();
  await expect(page.locator('#node-architecture.state-done')).toBeVisible({ timeout: 30_000 });

  await page.locator('#node-tests').click();
  const detail = page.locator('aside.detail');
  await detail.getByRole('button', { name: 'Redirect to…' }).click();
  const form = page.getByRole('form', { name: 'Redirect node' });
  await form.getByLabel('Model').fill('mock-alpha/m1');
  await form.getByRole('button', { name: 'Redirect' }).click();
  await expect(page.getByRole('region', { name: 'Steering' })).toContainText(/mock-alpha\/m1/);
  await controls.getByRole('button', { name: 'Resume' }).click();
  await expect(page.locator('.graph .node.state-done')).toHaveCount(4, { timeout: 45_000 });
});
