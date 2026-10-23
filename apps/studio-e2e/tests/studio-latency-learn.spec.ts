/**
 * Spec §4.5 "< 100 ms for any local action", on the phase 4 screens: the memory and the
 * accuracy tabs, the memory edit form, the replay dialog and picking a dispute option.
 * Measured inside the page from the input event to the frame after the DOM shows the
 * result (as in latency.spec.ts); p95 of 15 samples each, written to
 * test-results/ui-latency-learn.json for the phase report.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { CODE_REQUEST } from '../fixtures/kernel.js';
import { confirmDialog, connected, expect, plan, test } from '../fixtures/test.js';

const SAMPLES = 15;
const BUDGET_MS = 100;

async function arm(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const w = window as unknown as { __lat?: Promise<number> };
    w.__lat = new Promise<number>((resolve) => {
      let t0: number | undefined;
      const types = ['keydown', 'pointerdown', 'mousedown', 'input', 'change'];
      const start = (e: Event) => {
        t0 ??= e.timeStamp;
        check();
      };
      const observer = new MutationObserver(() => check());
      function check(): void {
        if (t0 === undefined || document.querySelector(sel) === null) return;
        observer.disconnect();
        for (const t of types) window.removeEventListener(t, start, true);
        const from = t0;
        requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - from), 0));
      }
      for (const t of types) window.addEventListener(t, start, true);
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    });
  }, selector);
}

async function sample(page: Page, selector: string, act: () => Promise<void>): Promise<number> {
  await arm(page, selector);
  await act();
  return page.evaluate(() => (window as unknown as { __lat: Promise<number> }).__lat);
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r(at(0.5)), p95: r(at(0.95)), max: r(s.at(-1)!), samples: xs.map(r) };
}

test('phase 4 local actions answer in under 100 ms', async ({ open }) => {
  const page = await open();
  await connected(page);
  const results: Record<string, ReturnType<typeof stats>> = {};
  const run = async (name: string, step: (i: number) => Promise<number>) => {
    const xs: number[] = [];
    for (let i = 0; i < SAMPLES; i++) xs.push(await step(i));
    results[name] = stats(xs);
  };

  await plan(page, CODE_REQUEST);
  await page.getByRole('button', { name: /^Run/ }).click();
  await expect(page.locator('.graph .node.state-done')).toHaveCount(4, { timeout: 45_000 });

  await run('switch to the Memory / Accuracy tab', async (i) => {
    const tab = i % 2 === 0 ? 'memory' : 'evidence';
    return sample(page, `#panel-${tab}`, () => page.locator(`#tab-${tab}`).click());
  });

  await page.locator('#tab-memory').click();
  const project = page.getByRole('region', { name: 'Memory: project' });
  await project.getByLabel('Add a fact to project memory').fill('Use pnpm');
  await project.getByRole('button', { name: 'Add' }).click();
  await expect(project.locator('.facts')).toContainText('Use pnpm');
  await run('open the memory edit form', async () => {
    const t = await sample(page, '.fact-edit', () =>
      project.getByRole('button', { name: 'Edit' }).click(),
    );
    await project.getByRole('button', { name: 'Cancel' }).click();
    return t;
  });

  await page.locator('#node-implementation').click();
  await run('open the replay dialog', async () => {
    const t = await sample(page, '.modal #replay-model', () =>
      page.getByRole('button', { name: 'Replay…' }).click(),
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    return t;
  });

  const votes =
    '[[vote:redis@mock-alpha]] [[vote:postgres@mock-beta]] [[vote:sqlite@mock-gamma]] [[vote:mysql@mock-delta]]';
  await plan(page, `which database should we use: redis or postgres? ${votes}`);
  await page.getByRole('button', { name: /^Run/ }).click();
  const dialog = confirmDialog(page);
  await expect(dialog).toContainText('reviewers disagree', { timeout: 45_000 });
  await run('pick a dispute option', async (i) => {
    const n = i % 3;
    return sample(page, `#dispute-opt-${n}:checked`, () =>
      page.locator(`#dispute-opt-${n}`).click(),
    );
  });
  await page.keyboard.press('Escape');

  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/ui-latency-learn.json', `${JSON.stringify(results, null, 2)}\n`);
  for (const [name, r] of Object.entries(results))
    console.log(`latency ${name}: p50 ${r.p50} ms · p95 ${r.p95} ms · max ${r.max} ms (n=${r.n})`);
  for (const [name, r] of Object.entries(results))
    expect(r.p95, `${name} p95 (ms)`).toBeLessThan(BUDGET_MS);
});
