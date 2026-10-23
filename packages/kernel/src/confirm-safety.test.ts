/**
 * Phase 3 review regressions in the kernel: one confirmation per patch (P3-F1), cancel voids
 * the run's confirmations (P3-F2), serialized questions (P3-F9), no run-time waivers on an
 * approved plan (P3-F6), and isolated runs side by side (P3-F11).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Kernel } from './kernel.js';
import { REQ, TEST_OPTIONS, recordingHost } from './test-helpers/fixture.js';
import { TWO_PATCHES, holdingHost, until } from './test-helpers/hold.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };

describe('P3-F1: one confirmation per patch', () => {
  it('asks once per patch of the same node, each with its own diff', async () => {
    const host = recordingHost(CHEAP);
    host.fallback = true;
    const k = new Kernel(host);
    const h = await k.startRun({ request: TWO_PATCHES, options: TEST_OPTIONS });
    const o = await h.done;
    if (o.status !== 'finished') throw new Error('not run');
    const fromImpl = o.patches.filter((p) => p.nodeId === 'implementation');
    expect(fromImpl.map((p) => p.files)).toEqual([['a.txt'], ['b.txt']]);
    host.answers = [true, false];
    const results = await k.applyPatches(h.runId, { nodeIds: ['implementation'] });
    const asked = host.asked.filter((a) => a.kind === 'patch').map((a) => a.patch);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/\+\+\+ b\/a\.txt/);
    expect(asked[1]).toMatch(/\+\+\+ b\/b\.txt/);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(existsSync(join(host.cwd, 'a.txt'))).toBe(true);
    expect(existsSync(join(host.cwd, 'b.txt'))).toBe(false);
    await k.close();
  });
});

describe('P3-F2: a cancel voids the run’s confirmations', () => {
  it('declines the questions queued behind the open one, and tells the host', async () => {
    // The architecture debate's second round: both debaters ask at once. The first question
    // is held on screen; the second waits in the kernel's queue.
    const { host, hold } = holdingHost(3);
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: { ...TEST_OPTIONS, isolated: false } });
    await until(() => hold.release !== undefined);
    await new Promise((r) => setTimeout(r, 50));
    const asked = host.asked.length;
    expect(k.cancel(h.runId)).toBe(true);
    expect(hold.cancelled).toEqual([h.runId]);
    hold.release?.(true); // a late yes on the dialog
    const o = await h.done;
    expect(o).toMatchObject({ status: 'finished', cancelled: true });
    expect(host.asked.length).toBe(asked);
    await k.close();
  });
});

describe('P3-F9: confirmations are asked one at a time', () => {
  // The debate's second round runs both debaters at once: each asks before its call.
  it('parallel steps never have two questions open at once', async () => {
    const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '0' });
    let open = 0;
    let most = 0;
    host.confirm = async () => {
      most = Math.max(most, ++open);
      await new Promise((r) => setTimeout(r, 20));
      open -= 1;
      return true;
    };
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: { ...TEST_OPTIONS, isolated: false } });
    expect((await h.done).status).toBe('finished');
    expect(most).toBe(1);
    await k.close();
  });
});

describe('P3-F6: no run-time waivers on an approved plan', () => {
  it('ignores overBudget given at start when the plan did not have it', async () => {
    const host = recordingHost({ ...CHEAP, KPAI_BUDGET_SESSION_USD: '0.0001' });
    const k = new Kernel(host);
    const p = await k.plan(REQ, TEST_OPTIONS);
    const options = { ...TEST_OPTIONS, overBudget: true, allowSameProvider: true };
    const h = await k.startRun({ request: REQ, planId: p.planId, options });
    expect((await h.done).status).toBe('not_run');
    expect(host.said.join('')).toMatch(/graph blocked by session budget/);
    const waived = await k.plan(REQ, { ...TEST_OPTIONS, overBudget: true });
    const ok = await k.startRun({ request: REQ, planId: waived.planId, options: TEST_OPTIONS });
    expect((await ok.done).status).toBe('finished');
    await k.close();
  });
});
