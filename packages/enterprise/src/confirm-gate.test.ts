/**
 * The envelope answers a program run's questions only for `budget-within-envelope` and
 * `write-in-worktree`, on typed facts; everything else waits for the Sponsor (ADR-0035).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfirmRequest } from '@kernelpai/kernel';
import { withoutReservation } from './confirm-gate.js';
import { fakeStarter } from './test-helpers/fake.js';
import { GOAL, world, type World } from './test-helpers/world.js';

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function runningProgram(x: World): Promise<string> {
  const d = await x.rt.create({ goal: 'one thing', budgetUsd: 10, critic: false });
  await x.rt.sponsor.act(d.programId, { type: 'approve', charterHash: d.charterHash });
  const fake = fakeStarter(x.rt);
  await x.rt.daemon.tick();
  await x.rt.idle();
  expect(fake.runs).toHaveLength(1);
  return d.programId;
}

const ctxOf = (id: string) => ({ programId: id, wpId: 'wp1' });
const base = { question: 'q?', runId: 'run-x', physical: false } as const;

describe('envelope pre-answers (R-5PA)', () => {
  it('pre-answers an in-envelope budget question and an in-worktree write, journaled', async () => {
    w = world();
    const id = await runningProgram(w);
    const gate = w.rt.ctx.gate;
    expect(await gate.decide(ctxOf(id), { ...base, kind: 'budget', amountUsd: 0.5 })).toBe(true);
    const write: ConfirmRequest = { ...base, kind: 'tool', risk: 'write', inWorktree: true };
    expect(await gate.decide(ctxOf(id), write)).toBe(true);
    const facts = w.kernel
      .events(w.rt.ctx.sessionOf(id), 1_000)
      .filter((e) => e.payload['action'] === 'pre-answered');
    expect(facts.map((e) => e.payload['rule'])).toEqual(['budget.within', 'confirm.worktree']);
    expect(w.rt.get(id).escalations).toHaveLength(0);
  });

  const asks: Array<[string, ConfirmRequest]> = [
    ['an unknown amount', { ...base, kind: 'budget' }],
    ['an amount beyond the envelope', { ...base, kind: 'budget', amountUsd: 50 }],
    ['a write in the user tree', { ...base, kind: 'patch', risk: 'write', inWorktree: false }],
    [
      'a destructive tool in the worktree',
      { ...base, kind: 'tool', risk: 'destructive', inWorktree: true },
    ],
    ['a restore', { ...base, kind: 'restore', inWorktree: true }],
    ['a physical step', { ...base, kind: 'tool', risk: 'write', inWorktree: true, physical: true }],
    ['an unstated physical fact', { kind: 'tool', question: 'q', risk: 'write', inWorktree: true }],
    ['a dispute', { ...base, kind: 'dispute', inWorktree: true }],
    ['a memory fact', { ...base, kind: 'memory', inWorktree: true }],
  ];
  for (const [what, req] of asks) {
    it(`asks the Sponsor for ${what}; silence is a no`, async () => {
      w = world();
      w.config({ confirmWaitMinutes: 0.01 });
      const id = await runningProgram(w);
      const answer = await w.rt.ctx.gate.decide(ctxOf(id), req);
      expect(answer).toBe(false);
      const [e] = w.rt.get(id).escalations;
      expect(e).toBeDefined();
      expect(w.rt.get(id).meta.escalations[e!.id]).toMatchObject({
        kind: 'confirm',
        expired: true,
      });
      await expect(w.rt.sponsor.answer(id, e!.id, 'yes')).rejects.toThrow(/expired/);
    });
  }

  it('the run waits for the Sponsor and gets their answer', async () => {
    w = world();
    const id = await runningProgram(w);
    // A read tool's question: trivial (D-035: a write outside a worktree no longer is).
    const pending = w.rt.ctx.gate.decide(ctxOf(id), { ...base, kind: 'tool', risk: 'read' });
    let e: { id: string } | undefined;
    for (let i = 0; i < 100 && !e; i++) {
      await new Promise((r) => setTimeout(r, 10));
      e = w.rt.get(id).escalations[0];
    }
    expect(w.rt.snapshot().inbox[0]).toMatchObject({ escalationId: e!.id, class: 'trivial' });
    await w.rt.sponsor.answer(id, e!.id, 'yes');
    expect(await pending).toBe(true);
  });

  it('a paused program refuses its run’s questions', async () => {
    w = world();
    const id = await runningProgram(w);
    await w.rt.sponsor.act(id, { type: 'pause' });
    expect(await w.rt.ctx.gate.decide(ctxOf(id), { ...base, kind: 'budget', amountUsd: 0.1 })).toBe(
      false,
    );
  });

  it('a live run’s own band top is not counted twice', async () => {
    w = world();
    const id = await runningProgram(w);
    const s = w.rt.get(id);
    const runId = s.runs[0]!.runId;
    const freed = withoutReservation(s, runId);
    expect(freed.runs[0]!.capUsd).toBe(0);
    expect(withoutReservation(s, 'other').runs[0]!.capUsd).toBe(s.runs[0]!.capUsd);
  });
});

describe('the kernel routes a program run’s questions to the envelope', () => {
  it('budget questions of a real run are pre-answered; no human is asked', async () => {
    w = world({ KPAI_CONFIRM_ABOVE_USD: '0' });
    const d = await w.rt.create({ goal: GOAL, budgetUsd: 20, critic: false });
    const before = w.human.length;
    await w.rt.sponsor.act(d.programId, { type: 'approve', charterHash: d.charterHash });
    await w.until(
      () => w!.rt.get(d.programId).runs.filter((r) => r.status === 'finished').length === 2,
    );
    expect(w.human.length).toBe(before);
    const pre = w.kernel
      .events(w.rt.ctx.sessionOf(d.programId), 10_000)
      .filter((e) => e.payload['action'] === 'pre-answered');
    expect(pre.length).toBeGreaterThan(0);
  });
});
