/**
 * Spec §4.5: "< 100 ms for any local action". Each sample is measured inside the page, from
 * the input event's timestamp (keydown, pointerdown or input) to the frame after the DOM
 * shows the result, so test-runner overhead is not counted. 15 samples per action; the
 * assertion is on the 95th percentile, and every number is written to
 * test-results/ui-latency.json for the phase report.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { CODE_REQUEST } from '../fixtures/kernel.js';
import { connected, expect, plan, test } from '../fixtures/test.js';

const SAMPLES = 15;
const BUDGET_MS = 100;

/** Done when `selector` matches (or no longer matches, with `present: false`). */
interface Until {
  selector: string;
  present?: boolean;
}

/** Arms the page: the next input event starts the clock, the DOM condition stops it. */
async function arm(page: Page, until: Until): Promise<void> {
  await page.evaluate(({ selector, present }) => {
    const w = window as unknown as { __lat?: Promise<number> };
    w.__lat = new Promise<number>((resolve) => {
      let t0: number | undefined;
      const types = ['keydown', 'pointerdown', 'mousedown', 'input', 'change'];
      const start = (e: Event) => {
        t0 ??= e.timeStamp;
        check();
      };
      const done = () => (document.querySelector(selector) !== null) === (present ?? true);
      const observer = new MutationObserver(() => check());
      function check(): void {
        if (t0 === undefined || !done()) return;
        observer.disconnect();
        for (const t of types) window.removeEventListener(t, start, true);
        const from = t0;
        // The frame after the change: rAF runs before paint, the task after it follows paint.
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
  }, until);
}

async function sample(page: Page, until: Until, act: () => Promise<void>): Promise<number> {
  await arm(page, until);
  await act();
  return page.evaluate(() => (window as unknown as { __lat: Promise<number> }).__lat);
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r(at(0.5)), p95: r(at(0.95)), max: r(s.at(-1)!), samples: xs.map(r) };
}

test('local actions answer in under 100 ms', async ({ open }) => {
  const page = await open();
  await connected(page);
  await plan(page, CODE_REQUEST);
  const results: Record<string, ReturnType<typeof stats>> = {};
  const run = async (name: string, step: (i: number) => Promise<number>) => {
    const xs: number[] = [];
    for (let i = 0; i < SAMPLES; i++) xs.push(await step(i));
    results[name] = stats(xs);
  };

  await run('open the command palette (Ctrl+K)', async () => {
    const t = await sample(page, { selector: '.palette' }, () => page.keyboard.press('Control+k'));
    await page.keyboard.press('Escape');
    await expect(page.locator('.palette')).toHaveCount(0);
    return t;
  });

  await run('switch central tab (click)', async (i) => {
    const tab = i % 2 === 0 ? 'diff' : 'conversation';
    return sample(page, { selector: `#panel-${tab}` }, () => page.locator(`#tab-${tab}`).click());
  });

  await run('switch central tab (arrow key)', async (i) => {
    const [from, to] = i % 2 === 0 ? ['conversation', 'diff'] : ['diff', 'conversation'];
    await page.locator(`#tab-${from}`).click();
    await expect(page.locator(`#tab-${from}`)).toBeFocused();
    return sample(page, { selector: `#panel-${to}` }, () =>
      page.keyboard.press(i % 2 === 0 ? 'ArrowRight' : 'ArrowLeft'),
    );
  });

  await run('open a node detail (click)', async () => {
    const t = await sample(page, { selector: 'aside.detail' }, () =>
      page.locator('#node-implementation').click(),
    );
    await page.locator('#node-implementation').click();
    await expect(page.locator('aside.detail')).toHaveCount(0);
    return t;
  });

  await page.locator('#node-implementation').click();
  await run("edit the plan (a node's model)", async (i) => {
    const pin = i % 2 === 0;
    return sample(page, { selector: '#node-implementation .tag', present: pin }, async () => {
      await page.locator('#edit-model').selectOption(pin ? 'mock-alpha/m1' : '');
    });
  });

  await run('switch language (whole console re-rendered)', async (i) => {
    const fr = i % 2 === 0;
    return sample(page, { selector: `html[lang="${fr ? 'fr' : 'en'}"]` }, async () => {
      await page.locator('#lang-select').selectOption(fr ? 'fr' : 'en');
    });
  });

  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/ui-latency.json', `${JSON.stringify(results, null, 2)}\n`);
  for (const [name, r] of Object.entries(results))
    console.log(`latency ${name}: p50 ${r.p50} ms · p95 ${r.p95} ms · max ${r.max} ms (n=${r.n})`);
  for (const [name, r] of Object.entries(results))
    expect(r.p95, `${name} p95 (ms)`).toBeLessThan(BUDGET_MS);
});
