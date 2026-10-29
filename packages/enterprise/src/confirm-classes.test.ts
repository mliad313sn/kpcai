/**
 * D-035 (P5-F2): a program run's questions that spend past the accepted cap, run project
 * code (`test.run`, `shell.run`, browser, MCP), write outside a worktree or write a control
 * file are consequential: never pre-answered, never batch-approved, counted by G2. Only
 * in-envelope, in-worktree, low-risk questions stay trivial.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfirmRequest } from '@kernelpai/kernel';
import { approvalClass, rubberStampRate } from '@kernelpai/program';
import { fakeStarter } from './test-helpers/fake.js';
import { world, type World } from './test-helpers/world.js';

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function running(x: World) {
  const d = await x.rt.create({ goal: 'one thing', budgetUsd: 10, critic: false });
  await x.rt.sponsor.act(d.programId, { type: 'approve', charterHash: d.charterHash });
  const fake = fakeStarter(x.rt);
  await x.rt.daemon.tick();
  await x.rt.idle();
  return { programId: d.programId, fake, runId: fake.runs[0]!.runId };
}

const OVER_CAP = {
  kind: 'budget',
  question: 'graph total $9.50 > cap $1.00: the run would exceed the cap you accepted. Continue?',
  physical: false,
  overCap: true,
} as const;
const TESTS = {
  kind: 'tool',
  question: 'run tests: "npm" "test" (detected from package.json; sandbox: none)',
  risk: 'write',
  inWorktree: false,
  physical: false,
} as const;

async function opened(x: World, id: string, n: number) {
  for (let i = 0; i < 200; i++) {
    const open = x.rt.get(id).escalations.filter((e) => !e.answer);
    if (open.length >= n) return open;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('questions never reached the inbox');
}

describe('consequential program questions (D-035, P5-F2)', () => {
  it('spend past the accepted cap and test.run are never batch-approved; G2 counts them', async () => {
    w = world();
    const { programId, fake, runId } = await running(w);
    const ctx = { programId, wpId: 'wp1' };
    const over = w.rt.ctx.gate.decide(ctx, { ...OVER_CAP, runId });
    const tests = w.rt.ctx.gate.decide(ctx, { ...TESTS, runId });
    const open = await opened(w, programId, 2);
    expect(open.map((e) => e.rule).sort()).toEqual(['confirm.exec', 'confirm.overcap']);
    expect(open.every((e) => approvalClass(e) === 'consequential')).toBe(true);
    expect(w.rt.snapshot().inbox.every((i) => i.class === 'consequential')).toBe(true);
    const batch = await w.rt.sponsor.answerBatch(
      programId,
      open.map((e) => e.id),
      'yes',
    );
    expect(batch.answered).toEqual([]);
    expect(batch.refused).toHaveLength(2);
    // One at a time, after the evidence: answered at once, so both are rubber stamps.
    for (const e of open) {
      await w.rt.sponsor.viewed(programId, { kind: 'run', id: runId }, e.id);
      await w.rt.sponsor.answer(programId, e.id, 'yes');
    }
    expect(await over).toBe(true);
    expect(await tests).toBe(true);
    const g2 = rubberStampRate(w.rt.get(programId).meta.answers);
    expect(g2).toMatchObject({ consequential: 2, stamped: 2 });
    fake.runs.forEach((x) => x.finish());
  });

  it('a budget question without an amount is over-cap even without the flag', async () => {
    w = world();
    const { programId, fake, runId } = await running(w);
    const ctx = { programId, wpId: 'wp1' };
    void w.rt.ctx.gate.decide(ctx, { kind: 'budget', question: 'more?', runId, physical: false });
    const [e] = await opened(w, programId, 1);
    expect(e!.rule).toBe('confirm.overcap');
    fake.runs.forEach((x) => x.finish());
  });

  it('a control-file write in the worktree is not pre-answered; a plain one is', async () => {
    w = world();
    const { programId, fake, runId } = await running(w);
    const ctx = { programId, wpId: 'wp1' };
    const write: ConfirmRequest = {
      kind: 'tool',
      question: 'write src/a.ts',
      runId,
      risk: 'write',
      inWorktree: true,
      physical: false,
    };
    expect(await w.rt.ctx.gate.decide(ctx, write)).toBe(true);
    expect(w.rt.get(programId).escalations).toHaveLength(0);
    void w.rt.ctx.gate.decide(ctx, { ...write, question: 'write package.json', control: true });
    const [e] = await opened(w, programId, 1);
    expect(e!.rule).toBe('confirm.control');
    expect(approvalClass(e!)).toBe('consequential');
    fake.runs.forEach((x) => x.finish());
  });
});
