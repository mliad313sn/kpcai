/**
 * The Sponsor's side (S10 R8, R6 J2): a run over the envelope waits in the inbox; a
 * consequential yes needs the evidence opened first and never goes in a batch; the yes
 * covers that one run; answers are journaled with ask and answer times and `viewed`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EnterpriseSnapshotSchema } from '@kernelpai/kernel/protocol';
import { fakeStarter } from './test-helpers/fake.js';
import { world, type World } from './test-helpers/world.js';

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function overBudget(x: World) {
  const d = await x.rt.create({ goal: 'one thing', budgetUsd: 1, critic: false });
  await x.rt.sponsor.act(d.programId, { type: 'approve', charterHash: d.charterHash });
  const fake = fakeStarter(x.rt);
  fake.figures = { capUsd: 3, providers: ['mock-beta'], source: 'api' };
  await x.rt.daemon.tick();
  await x.rt.idle();
  return { id: d.programId, fake };
}

describe('inbox answers', () => {
  it('a run over the envelope waits; the viewed yes starts exactly that run, once', async () => {
    w = world();
    const { id, fake } = await overBudget(w);
    expect(fake.runs).toHaveLength(0);
    const snap = EnterpriseSnapshotSchema.parse(w.rt.snapshot());
    const item = snap.inbox[0]!;
    expect(item).toMatchObject({ class: 'consequential', subject: { wpId: 'wp1', capUsd: 3 } });
    await expect(w.rt.sponsor.answer(id, item.escalationId, 'yes')).rejects.toThrow(
      /evidence first/,
    );
    const batch = await w.rt.sponsor.answerBatch(id, [item.escalationId], 'yes');
    expect(batch.answered).toEqual([]);
    expect(batch.refused[0]!.reason).toMatch(/batch/);
    await w.rt.sponsor.viewed(id, { kind: 'escalation', id: item.escalationId }, item.escalationId);
    await w.rt.sponsor.answer(id, item.escalationId, 'yes');
    await w.rt.daemon.tick();
    await w.rt.idle();
    expect(fake.runs).toHaveLength(1);
    expect(w.rt.get(id).escalations[0]!.consumed).toBe(true);
    const fact = w.kernel
      .events(w.rt.ctx.sessionOf(id), 1_000)
      .find((e) => e.payload['action'] === 'sponsor answer');
    expect(fact?.payload).toMatchObject({ viewed: true, class: 'consequential', answer: 'yes' });
    expect(fact?.payload['askedAt']).toBeTypeOf('string');
    expect(fact?.payload['answeredAt']).toBeTypeOf('string');
    // Answered within 3 s of opening the evidence: counted as a rubber stamp (G2).
    expect(w.rt.snapshot().rubberStamp).toEqual({ rate: 1, consequential: 1 });
    fake.runs.forEach((r) => r.finish());
  });

  it('a no keeps the work package waiting; unknown programs and questions are not found', async () => {
    w = world();
    const { id, fake } = await overBudget(w);
    const e = w.rt.get(id).escalations[0]!;
    await w.rt.sponsor.viewed(id, { kind: 'escalation', id: e.id }, e.id);
    await w.rt.sponsor.answer(id, e.id, 'no');
    await w.rt.daemon.tick();
    await w.rt.idle();
    expect(fake.runs).toHaveLength(0);
    await expect(w.rt.sponsor.answer(id, e.id, 'yes')).rejects.toThrow(/no open question/);
    await expect(w.rt.sponsor.act('prog-none', { type: 'pause' })).rejects.toThrow(/no program/);
    await expect(w.rt.sponsor.viewed(id, { kind: 'run', id: 'nope' })).rejects.toThrow(/no run/);
  });

  it('stop cancels the program and is final', async () => {
    w = world();
    const { id } = await overBudget(w);
    await w.rt.sponsor.stop(id, 'enough');
    expect(w.rt.get(id).status).toBe('stopped');
    await expect(w.rt.sponsor.act(id, { type: 'resume' })).rejects.toThrow(/not paused/);
    expect(w.rt.list()[0]).toMatchObject({ programId: id, health: 'blocked' });
  });
});
