/**
 * Review P4-R3: a replay or fork cannot waive provider diversity (principle 2) unseen. It
 * may only keep the waiver of the original run, and the plan then says so. Offline.
 */
import { readRun } from '@kernelpai/orchestrator';
import { describe, expect, it } from 'vitest';
import { Kernel } from './kernel.js';
import { routingFloor } from './setup.js';
import { REQ, TEST_OPTIONS, recordingHost } from './test-helpers/fixture.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };
const IN_PLACE = { ...TEST_OPTIONS, isolated: false } as const;
const WAIVE = { ...TEST_OPTIONS, allowSameProvider: true } as const;

const code = (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e as { code?: string }).code ?? String(e),
  );

describe('P4-R3: provider diversity in replay and fork', () => {
  it('refuses allowSameProvider when the original run kept diversity', async () => {
    const k = new Kernel(recordingHost(CHEAP));
    const h = await k.startRun({ request: REQ, options: IN_PLACE });
    await h.done;
    expect(readRun(k['journal'], h.runId)?.routing?.allowSameProvider).toBeUndefined();
    expect(await code(k.replayPlan(h.runId, 'implementation', {}, WAIVE))).toBe('refused');
    expect(await code(k.forkPlan(h.runId, 'implementation', {}, WAIVE))).toBe('refused');
    // Without the waiver it plans as before.
    const plan = await k.replayPlan(h.runId, 'implementation', {}, TEST_OPTIONS);
    expect(plan.options.allowSameProvider).toBeUndefined();
    await k.close();
  });

  it('keeps the waiver of a run that had it, recorded with the run', async () => {
    const k = new Kernel(recordingHost(CHEAP));
    const h = await k.startRun({ request: REQ, options: { ...IN_PLACE, allowSameProvider: true } });
    await h.done;
    expect(readRun(k['journal'], h.runId)?.routing?.allowSameProvider).toBe(true);
    const plan = await k.replayPlan(h.runId, 'implementation', {}, WAIVE);
    expect(plan.options.allowSameProvider).toBe(true);
    const fork = await k.forkPlan(h.runId, 'implementation', {}, WAIVE);
    expect(fork.options.allowSameProvider).toBe(true);
    await k.close();
  });

  it('refuses it for a run journaled without a routing record', () => {
    expect(() => routingFloor({ allowSameProvider: true }, undefined)).toThrow(/diversity/);
    expect(routingFloor({}, undefined)).toEqual({});
  });
});
