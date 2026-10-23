/**
 * R-303 "why this model", one click from the graph, identical to the kernel's routing data;
 * R-302 cost as a band with the cap before launch, and a live meter during the run.
 */
import { CODE_REQUEST } from '../fixtures/kernel.js';
import { rpc } from '../fixtures/rpc.js';
import { connected, expect, plan, test } from '../fixtures/test.js';

interface NodeEstimate {
  nodeId: string;
  reason?: string;
  score?: number;
  runnerUp?: { ref: { provider: string; model: string }; score: number };
  parts?: Record<string, number | null>;
}

test('the routing panel shows the kernel reason, score, breakdown and runner-up', async ({
  open,
  kernel,
}) => {
  const page = await open();
  await connected(page);
  await plan(page, CODE_REQUEST);
  // The router is deterministic: a second plan of the same request gives the same routing.
  const r = await rpc(kernel.server.port, kernel.server.token);
  const est = await r
    .call<{ estimate: { nodes: NodeEstimate[] } }>('plan', { request: CODE_REQUEST, options: {} })
    .finally(() => r.close());
  const arch = est.estimate.nodes.find((n) => n.nodeId === 'architecture')!;
  expect(arch.reason).toBeTruthy();

  await page.locator('#node-architecture').click();
  const panel = page.getByRole('region', { name: 'Why this model' });
  await expect(panel).toContainText(arch.reason!);
  await expect(panel.locator('dd').first()).toHaveText(arch.score!.toFixed(2));
  const up = arch.runnerUp!;
  await expect(panel).toContainText(
    `${up.ref.provider}/${up.ref.model} (score ${up.score.toFixed(2)})`,
  );
  const breakdown = panel.getByRole('table', { name: 'Score breakdown' });
  for (const name of Object.keys(arch.parts!))
    await expect(breakdown.getByRole('rowheader', { name })).toBeVisible();
  await expect(breakdown.getByRole('row', { name: /^measuredCompetence/ })).toContainText(
    'not measured',
  );
  // Every protocol step and its model, with calls and cost range.
  const steps = panel.getByRole('table', { name: 'Planned steps' });
  await expect(steps.getByRole('row')).toHaveCount(6);
  await expect(steps).toContainText('judge');
});

test('cost band and cap before launch; live meter updated on every response', async ({ open }) => {
  const page = await open();
  await connected(page);
  await plan(page, `${CODE_REQUEST} [[slow]]`);
  const band = page.locator('.plan-bar .cost-band');
  await expect(band).toHaveText(
    /^Estimate \$\d+\.\d+–\$\d+\.\d+ \(heuristic: no calibration yet\) · cap \$\d+\.\d+$/,
  );
  const cap = /cap (\$[\d.]+)/.exec((await band.textContent()) ?? '')![1]!;
  await expect(page.getByRole('button', { name: /^Run/ })).toHaveText(`Run (cap ${cap})`);
  await page.getByRole('button', { name: /^Run/ }).click();

  const meter = page.getByRole('meter');
  await expect(meter).toBeVisible();
  await expect(page.locator('.cost-meter label')).toContainText(`of cap ${cap}`);
  const values: number[] = [];
  const read = async () => Number(await meter.getAttribute('value'));
  await expect.poll(read).toBeGreaterThan(0);
  values.push(await read());
  await expect.poll(read, { timeout: 20_000 }).toBeGreaterThan(values[0]!);
  values.push(await read());
  await expect(page.locator('.graph .node.state-done')).toHaveCount(4, { timeout: 45_000 });
  values.push(await read());
  expect(values[2]!).toBeGreaterThanOrEqual(values[1]!);
  expect(await meter.getAttribute('aria-valuetext')).toMatch(/spent, \d+% of the cap, band \$/);
  // The run finished inside its cap (and, on these mocks, inside its band).
  expect(values[2]!).toBeLessThanOrEqual(Number(cap.slice(1)));
  await expect(page.locator('.cost-meter')).toContainText(/band \$/);
});

// Known gap (reported to S1): the kernel explains a node only when an unconstrained
// re-route agrees with the estimate (packages/kernel/src/routing-info.ts:69-71), so the
// review node, whose model is set by critic diversity (principle 2), shows no reason.
// `test.fail` keeps the suite green and turns red once the kernel explains that node.
test('R-303: the diversity-constrained review node shows the router reason', async ({ open }) => {
  test.fail(true, 'review node has no routing reason (R-303 gap, owner S1)');
  const page = await open();
  await connected(page);
  await plan(page, CODE_REQUEST);
  await page.locator('#node-review').click();
  const panel = page.getByRole('region', { name: 'Why this model' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/^No routing reason/)).toHaveCount(0, { timeout: 2000 });
});
