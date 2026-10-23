/**
 * Phase 3 review regressions on run outcomes and trees: merge reads the journaled outcome
 * (P3-F7), restore waits for in-place runs (P3-F7), two isolated runs side by side (P3-F11).
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KernelError } from './errors.js';
import { Kernel } from './kernel.js';
import { TEST_OPTIONS, recordingHost } from './test-helpers/fixture.js';
import { holdingHost, until } from './test-helpers/hold.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };
const ISOLATED = { ...TEST_OPTIONS, isolated: true } as const;
const IN_PLACE = { ...TEST_OPTIONS, isolated: false } as const;

const req = (name: string): string =>
  `add an OAuth state validator with tests [[diff:src/${name}.ts]] [[testdiff:test/${name}.test.ts]]`;

const code = (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e instanceof KernelError ? e.code : String(e)),
  );

describe('P3-F7: merge reads the run outcome from the journal', () => {
  it('refuses to merge a cancelled run from a kernel that never held it', async () => {
    const { host, hold } = holdingHost();
    const a = new Kernel(host);
    const h = await a.startRun({ request: req('s'), options: ISOLATED });
    await until(() => hold.release !== undefined);
    a.cancel(h.runId);
    hold.release?.(false);
    const o = await h.done;
    expect(o).toMatchObject({ status: 'finished', cancelled: true, worktree: expect.any(String) });
    expect(await code(a.merge(h.runId))).toBe('refused');
    await a.close();
    const b = new Kernel(host); // a new process: `kpai merge`, or a restarted console
    expect(await code(b.merge(h.runId))).toBe('refused');
    expect(await code(b.merge(randomUUID()))).toBe('refused');
    await b.close();
  });

  it('merges a finished run from another kernel', async () => {
    const host = recordingHost(CHEAP);
    const a = new Kernel(host);
    const h = await a.startRun({ request: req('s'), options: ISOLATED });
    await h.done;
    await a.applyPatches(h.runId, { yesApply: true });
    await a.close();
    host.fallback = true;
    const b = new Kernel(host);
    expect(await b.merge(h.runId)).toMatchObject({ merged: true });
    expect(existsSync(join(host.cwd, 'src/s.ts'))).toBe(true);
    await b.close();
  });
});

describe('P3-F7: restore waits for in-place runs', () => {
  it('refuses a workspace restore while a run writes in place', async () => {
    const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '0' });
    // The kernel takes the host's confirm once: holding is switched on later.
    let holding = false;
    let release: ((ok: boolean) => void) | undefined;
    host.confirm = (q) =>
      !holding || release || q.kind !== 'budget' || q.question.includes('graph estimate')
        ? Promise.resolve(q.kind === 'budget')
        : new Promise((r) => (release = r));
    const k = new Kernel(host);
    const first = await k.startRun({ request: req('s'), options: IN_PLACE });
    await first.done;
    await k.applyPatches(first.runId, { yesApply: true });
    const [cp] = await k.checkpoints(first.runId);
    expect(cp?.where).toBe('workspace');
    holding = true;
    const second = await k.startRun({ request: req('t'), options: IN_PLACE });
    await until(() => release !== undefined);
    expect(await code(k.restore(cp?.ref ?? '', first.runId))).toBe('refused');
    release?.(true);
    await second.done;
    // Once it has finished, the restore is asked (and declined here).
    expect(await k.restore(cp?.ref ?? '', first.runId)).toMatchObject({ restored: false });
    await k.close();
  });
});

describe('P3-F11: two isolated runs at once on one repository (R-307)', () => {
  it('keeps each run’s diff in its own worktree', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const one = await k.startRun({ request: req('one'), options: ISOLATED });
    const two = await k.startRun({ request: req('two'), options: ISOLATED });
    const [o1, o2] = await Promise.all([one.done, two.done]);
    expect(o1).toMatchObject({ status: 'finished', worktree: expect.any(String) });
    expect(o2).toMatchObject({ status: 'finished', worktree: expect.any(String) });
    await k.applyPatches(one.runId, { yesApply: true });
    await k.applyPatches(two.runId, { yesApply: true });
    const d1 = await k.workspace.diff(one.runId);
    const d2 = await k.workspace.diff(two.runId);
    expect(d1?.files.sort()).toEqual(['src/one.ts', 'test/one.test.ts']);
    expect(d2?.files.sort()).toEqual(['src/two.ts', 'test/two.test.ts']);
    expect(existsSync(join(host.cwd, 'src/one.ts'))).toBe(false);
    expect(existsSync(join(host.cwd, 'src/two.ts'))).toBe(false);
    await k.close();
  });
});
