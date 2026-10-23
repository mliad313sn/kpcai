/**
 * R-5E11 performance: local actions of the Enterprise view under 100 ms (95th percentile of
 * 15 in-page samples each), and a 500-seat portfolio that stays windowed and smooth, also
 * while a burst of 500 seat updates arrives. Numbers go to test-results/enterprise-perf.json.
 */
import { expect, test } from '@playwright/test';
import { openFake, shot, showEnterprise } from '../fixtures/enterprise.js';
import { record, sample, stats, type Stats } from '../fixtures/measure.js';

const SAMPLES = 15;
const BUDGET_MS = 100;

async function series(step: (i: number) => Promise<number>): Promise<Stats> {
  const xs: number[] = [];
  for (let i = 0; i < SAMPLES; i++) xs.push(await step(i));
  return stats(xs);
}

function report(results: Record<string, Stats>): void {
  record('enterprise-perf.json', results);
  for (const [name, r] of Object.entries(results))
    console.log(`latency ${name}: p50 ${r.p50} ms · p95 ${r.p95} ms · max ${r.max} ms (n=${r.n})`);
  for (const [name, r] of Object.entries(results))
    expect(r.p95, `${name} p95 (ms)`).toBeLessThan(BUDGET_MS);
}

test('Enterprise local actions answer in under 100 ms', async ({ page }) => {
  await openFake(page);
  await showEnterprise(page);
  const results: Record<string, Stats> = {};
  results['switch view (Alt+E)'] = await series(async (i) => {
    const to = i % 2 === 0 ? '#zone-center-heading' : '#ent-title';
    return sample(page, { selector: to }, () => page.keyboard.press('Alt+e'));
  });
  // An odd number of samples ends in the workspace: come back.
  if ((await page.locator('#ent-title').count()) === 0) await page.keyboard.press('Alt+e');
  await expect(page.locator('#ent-title')).toBeVisible();
  results['switch panel (click)'] = await series(async (i) => {
    const pane = ['activity', 'reports', 'org'][i % 3]!;
    return sample(page, { selector: `#ent-panel-${pane}` }, () =>
      page.locator(`#ent-tab-${pane}`).click(),
    );
  });
  results['team / departments'] = await series(async (i) => {
    const depts = i % 2 === 0;
    return sample(page, { selector: '.org-dept', present: depts }, () =>
      page.getByRole('button', { name: depts ? 'Departments (expert)' : 'One team' }).click(),
    );
  });
  results['open the evidence of an ask'] = await series(async (i) => {
    const open = i % 2 === 0;
    return sample(page, { selector: '.evidence-panel', present: open }, () =>
      page.getByRole('button', { name: open ? /Open the evidence/ : /Hide the evidence/ }).click(),
    );
  });
  report(results);
});

test('500 seats: windowed, keyboard reachable, smooth under a burst of updates', async ({
  page,
}) => {
  const fake = await openFake(page, { seats: 500 });
  const t0 = Date.now();
  await showEnterprise(page);
  await expect(page.getByRole('group', { name: 'Seats (500)' })).toBeVisible();
  const firstPaintMs = Date.now() - t0;
  const inDom = await page.locator('[data-seat-index]').count();
  expect(inDom).toBeGreaterThan(0);
  expect(inDom).toBeLessThan(150);
  await shot(page, 'enterprise-500-seats');
  const results: Record<string, Stats> = {};
  results['500 seats: team / departments'] = await series(async (i) => {
    const depts = i % 2 === 0;
    return sample(page, { selector: '.org-dept', present: depts }, () =>
      page.getByRole('button', { name: depts ? 'Departments (expert)' : 'One team' }).click(),
    );
  });
  const attention = fake.snap.seats.filter(
    (x) => x.state === 'waiting_for_you' || x.state === 'blocked',
  ).length;
  results['500 seats: filter'] = await series(async (i) => {
    const [value, count] = i % 2 === 0 ? ['attention', attention] : ['all', 500];
    return sample(page, { selector: `[role="group"][aria-label="Seats (${count})"]` }, () =>
      page
        .locator('#ent-seat-filter')
        .selectOption(value)
        .then(() => undefined),
    );
  });
  await page.locator('#ent-seat-filter').selectOption('all');
  await expect(page.getByRole('group', { name: 'Seats (500)' })).toBeVisible();
  await page.locator('[data-seat-index="0"]').focus();
  results['500 seats: End key to the last seat'] = await series(async (i) => {
    const key = i % 2 === 0 ? 'End' : 'Home';
    const index = i % 2 === 0 ? 499 : 0;
    // The roving tab stop moves in the same frame; focus follows it (checked below).
    return sample(page, { selector: `[data-seat-index="${index}"][tabindex="0"]` }, () =>
      page.keyboard.press(key),
    );
  });
  await page.keyboard.press('End');
  await expect(page.locator('[data-seat-index="499"]')).toBeFocused();
  await expect(page.locator('[data-seat-index="499"]')).toContainText('seat 500 of 500');
  // A burst: every seat changes at once; the store applies it in one frame.
  const burstStart = Date.now();
  fake.notifyMany(fake.snap.seats.map((s) => ['enterprise.seat', { ...s, state: 'reviewing' }]));
  await expect(page.locator('.ent-summary')).toContainText('500 working');
  const burstMs = Date.now() - burstStart;
  const frames = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let n = 0;
        const start = performance.now();
        const tick = () => {
          n++;
          if (performance.now() - start < 1000) requestAnimationFrame(tick);
          else resolve(n);
        };
        requestAnimationFrame(tick);
      }),
  );
  record('enterprise-perf.json', {
    '500 seats': { firstPaintMs, inDom, burstMs, framesPerSecondAfter: frames },
  });
  console.log(
    `500 seats: first paint ${firstPaintMs} ms, ${inDom} seat cards in the DOM, burst of 500 updates applied in ${burstMs} ms, ${frames} frames in the next second`,
  );
  expect(burstMs).toBeLessThan(2000);
  expect(frames).toBeGreaterThan(30);
  report(results);
});
