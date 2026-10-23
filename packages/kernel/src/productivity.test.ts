/**
 * R-406 at the kernel: productivity from the journal (changes, rollbacks, review yield),
 * the bench's cost question under `yes`, and kernel writes attributed to their run outside
 * git (the `checkpoint unavailable` intervention names the run). Offline.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Kernel } from './kernel.js';
import { MAX_PRODUCTIVITY_LIST } from './learning.js';
import { REQ, TEST_OPTIONS, recordingHost } from './test-helpers/fixture.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };
const IN_PLACE = { ...TEST_OPTIONS, isolated: false } as const;

const code = (f: () => unknown): Promise<string | undefined> =>
  Promise.resolve()
    .then(f)
    .then(
      () => undefined,
      (e: unknown) => (e as { code?: string }).code ?? String(e),
    );

describe('productivity at the kernel (R-406)', () => {
  it('a run applies 2 patches and restores 1: accepted 2, rolled back 1', async () => {
    const host = recordingHost(CHEAP);
    host.fallback = true;
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: IN_PLACE });
    const o = await h.done;
    expect(o.status === 'finished' && o.patches.length).toBe(2);
    const applied = await k.applyPatches(h.runId, { yesApply: true });
    expect(applied.map((r) => r.ok)).toEqual([true, true]);
    const cps = await k.checkpoints(h.runId);
    expect(cps).toHaveLength(2);
    // Back to before the second patch: it is undone, the first one stays.
    const r = await k.restore(cps[1]!.ref, h.runId);
    expect(r.restored).toBe(true);

    const p = k.learning.productivity();
    expect(p.changes).toMatchObject({ accepted: 2, declined: 0, failed: 0 });
    expect(p.rolledBack).toBe(1);
    expect(p.rollbackRate).toBe(0.5);
    expect(p.runs).toBeGreaterThanOrEqual(1);
    expect(p.costPerAcceptedChangeUsd).toBeGreaterThan(0);
    expect(p).not.toHaveProperty('list');
    const d = k.learning.productivity({ detail: true, reworkDays: 1 });
    expect(d.reworkWindowMs).toBe(86_400_000);
    expect(d.list?.map((c) => c.runKey)).toEqual([h.runId, h.runId]);
    expect(d.list!.length).toBeLessThanOrEqual(MAX_PRODUCTIVITY_LIST);
    const later = k.learning.productivity({ since: new Date(Date.now() + 60_000).toISOString() });
    expect(later.runs).toBe(0);
    expect(later.costPerAcceptedChangeUsd).toBeNull();
    expect(await code(() => k.learning.productivity({ since: 'yesterday-ish' }))).toBe('invalid');
    expect(await code(() => k.learning.productivity({ reworkDays: 0 }))).toBe('invalid');
    await k.close();
  });

  it('review.acceptedFindings equals the run verification of the run', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const h = await k.startRun({ request: `${REQ} [[reject]]`, options: IN_PLACE });
    const o = await h.done;
    if (o.status !== 'finished') throw new Error('the run did not finish');
    const v = (o.result as { verification: { acceptedFindings: number } }).verification;
    expect(v.acceptedFindings).toBeGreaterThan(0);
    expect(k.learning.productivity().review.acceptedFindings).toBe(v.acceptedFindings);
    await k.close();
  });
});

describe('kernel writes outside git are attributed to their run', () => {
  it('applies run A after run B ran: the change is A’s', async () => {
    const host = recordingHost(CHEAP);
    host.cwd = mkdtempSync(join(tmpdir(), 'kpai-plain-'));
    writeFileSync(join(host.cwd, '.kernelpai-workspace'), '');
    host.fallback = true;
    const k = new Kernel(host);
    const a = await k.startRun({ request: REQ, options: IN_PLACE });
    await a.done;
    const b = await k.startRun({ request: REQ, options: IN_PLACE });
    await b.done;
    expect(b.sessionId).toBe(a.sessionId);
    await k.applyPatches(a.runId, { nodeIds: ['implementation'], yesApply: true });
    const unavailable = k
      .events(a.sessionId, 10_000)
      .filter((e) => e.payload['action'] === 'checkpoint unavailable');
    expect(unavailable.map((e) => e.payload['runId'])).toEqual([a.runId]);
    const p = k.learning.productivity({ detail: true });
    expect(p.list?.map((c) => [c.runKey, c.status])).toEqual([[a.runId, 'accepted']]);
    await k.close();
  });
});

describe('kpai bench --yes (cost questions only)', () => {
  it('accepts the bench total without asking, and still writes nothing', async () => {
    const host = recordingHost(CHEAP);
    mkdirSync(join(host.cwd, 'src'));
    const fn = (n: number) =>
      `export function f${n}(a: number, b: number): number {\n  const x = a * ${n} + b;\n  return x > 10 ? x - 10 : x + 1;\n}\n`;
    writeFileSync(join(host.cwd, 'src/calc.ts'), [1, 2, 3].map(fn).join('\n'));
    spawnSync('git', ['add', '-A'], { cwd: host.cwd });
    spawnSync('git', ['commit', '-qm', 'src'], { cwd: host.cwd });
    const k = new Kernel(host);
    const r = await k.learning.bench({ options: { ...TEST_OPTIONS, yes: true } });
    expect(r.ran).toBe(true);
    expect(host.asked.some((a) => /^Bench: /.test(a.question))).toBe(false);
    expect(host.said.some((s) => /^Bench: .* yes \(--yes accepts cost questions\)/.test(s))).toBe(
      true,
    );
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: host.cwd }).stdout.toString();
    expect(status).toBe('');
    await k.close();
  });
});
