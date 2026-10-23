/**
 * In-page latency samples (spec §4.5, R-5E11): from the input event's timestamp to the frame
 * after the DOM shows the result, so test-runner overhead is not counted. Same method as
 * tests/latency.spec.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

export interface Until {
  selector: string;
  present?: boolean;
}

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

export async function sample(page: Page, until: Until, act: () => Promise<void>): Promise<number> {
  await arm(page, until);
  await act();
  return page.evaluate(() => (window as unknown as { __lat: Promise<number> }).__lat);
}

export interface Stats {
  n: number;
  p50: number;
  p95: number;
  max: number;
  samples: number[];
}

export function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r(at(0.5)), p95: r(at(0.95)), max: r(s.at(-1)!), samples: xs.map(r) };
}

/** Adds results to test-results/<file> (several specs may write to it). */
export function record(file: string, results: Record<string, unknown>): void {
  mkdirSync('test-results', { recursive: true });
  const path = `test-results/${file}`;
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    /* first writer */
  }
  writeFileSync(path, `${JSON.stringify({ ...all, ...results }, null, 2)}\n`);
}
