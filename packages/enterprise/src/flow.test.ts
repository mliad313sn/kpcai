/**
 * The Enterprise runtime end to end on the real kernel with offline mock providers: a goal
 * becomes a charter (small team, baseline, cross-provider critic), the Sponsor approves the
 * hash, the daemon runs the work packages unattended in their own worktrees, opens the gate,
 * runs the independent review on another provider and asks the Sponsor to pass it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GOAL, world, type World } from './test-helpers/world.js';

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe('program flow', () => {
  it('drafts, approves by hash, runs two work packages and reaches the gate review', async () => {
    w = world();
    const d = await w.rt.create({ goal: GOAL, budgetUsd: 20 });
    expect(d.charter.seats.map((s) => s.kind)).toEqual(['builder', 'reviewer']);
    expect(d.charter.phases[0]!.workPackages).toHaveLength(2);
    expect(d.baseline.capUsd).toBeGreaterThan(0);
    expect(d.critique.status).toBe('done');
    expect(d.critique.providers.length).toBeGreaterThan(0);
    // Nothing runs before approval.
    await w.rt.daemon.tick();
    expect(w.rt.get(d.programId).runs).toHaveLength(0);
    await expect(
      w.rt.sponsor.act(d.programId, { type: 'approve', charterHash: 'nope' }),
    ).rejects.toThrow(/another charter/);
    await w.rt.sponsor.act(d.programId, { type: 'approve', charterHash: d.charterHash });
    const id = d.programId;
    await w.until(() => w!.rt.get(id).status === 'gate');
    const s = w.rt.get(id);
    const work = s.runs.filter((r) => r.purpose === 'work');
    expect(work.map((r) => r.status)).toEqual(['finished', 'finished']);
    expect(work.every((r) => r.assurance === 'V1')).toBe(true);
    await w.until(() => w!.rt.get(id).escalations.some((e) => e.rule === 'gate.pass'));
    const review = w.rt.get(id).runs.find((r) => r.purpose === 'review')!;
    const builders = new Set(work.flatMap((r) => r.providers));
    expect(review.providers.some((p) => builders.has(p))).toBe(false);
    expect(w.human).toEqual([]);
    expect(w.rt.reports(id).map((r) => r.kind)).toContain('gate');
    expect(w.rt.reports(id)[0]!.markdown).toMatch(/V1/);
    // The gate: consequential, so the Sponsor opens the review run before passing it.
    const gate = w.rt.get(id).escalations.find((e) => e.rule === 'gate.pass')!;
    await w.rt.sponsor.viewed(id, { kind: 'run', id: review.runId }, gate.id);
    await w.rt.sponsor.answer(id, gate.id, 'yes');
    await w.until(() => w!.rt.get(id).status === 'delivered');
    const done = w.rt.get(id);
    expect(done.gates[0]).toMatchObject({ verdict: 'pass', reviewerProvider: review.providers[0] });
    const final = w.rt.reports(id).find((r) => r.kind === 'final')!;
    // No CI for the exact commit here: delivered, honestly "not verified".
    expect(final.verified).toBe(false);
    expect(final.markdown).toMatch(/Not verified/);
    expect(w.rt.history(id).ok).toBe(true);
  });
});
