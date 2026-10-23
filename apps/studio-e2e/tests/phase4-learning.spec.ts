/**
 * Learning from outcomes end to end (ADR-0028, R-401, R-402): manual grades become measured
 * competence in this repository; below 5 graded tasks routing ignores them, from 5 on the
 * router's reason line cites the evidence. `stats.accuracy` reports estimates against the
 * costs the runs really billed, which we recompute from the runs themselves.
 */
import { ASK, CODE, expect, planAndRun, test, type Client, type Plan } from '../fixtures/phase4.js';

interface Competence {
  ref: { provider: string; model: string };
  taskType: string;
  samples: number;
  approved: number;
  score: number;
  evidence: string;
}

const lookReason = (p: Plan): string =>
  p.estimate.nodes.find((n) => n.nodeId === 'look')?.reason ?? '';

async function gradedRun(c: Client, grade: 'good' | 'bad'): Promise<string> {
  const { runId, done } = await planAndRun(c, ASK);
  expect(done.result.ok).toBe(true);
  const g = await c.call<{ graded: string; taskType?: string }>('grade', {
    runId,
    nodeId: 'look',
    grade,
  });
  expect(g).toMatchObject({ graded: 'mock-alpha/m1', taskType: 'analysis' });
  return runId;
}

test('grades become evidence in the routing reason once there are enough of them', async ({
  c,
}) => {
  const fresh = await c.call<Plan>('plan', { request: ASK, options: { isolated: false } });
  expect(lookReason(fresh)).toMatch(/^mock-alpha\/m1 for analysis/);
  expect(lookReason(fresh)).not.toContain('evidence:');

  const runs: string[] = [];
  for (let i = 0; i < 4; i++) runs.push(await gradedRun(c, 'good'));
  // P4-F9: a client cannot name the author (the server records its local user), so a
  // model's name here is dropped; grading a node again replaces its grade, never adds one.
  const again = await c.call<{ graded: string }>('grade', {
    runId: runs[0],
    nodeId: 'look',
    grade: 'good',
    author: 'mock-alpha/m1',
  });
  expect(again.graded).toBe('mock-alpha/m1');
  const four = await c.call<Plan>('plan', { request: ASK, options: { isolated: false } });
  expect(lookReason(four)).not.toContain('evidence:'); // n < 5: the prior alone

  runs.push(await gradedRun(c, 'good'));
  const { entries } = await c.call<{ entries: Competence[] }>('competence');
  const alpha = entries.find((e) => e.ref.provider === 'mock-alpha' && e.taskType === 'analysis');
  expect(alpha).toMatchObject({ samples: 5, approved: 5, score: 1 });
  const five = await c.call<Plan>('plan', { request: ASK, options: { isolated: false } });
  expect(lookReason(five)).toMatch(/; evidence: approved 5\/5 analysis tasks here/);
  expect(lookReason(five)).toContain(alpha!.evidence);
});

test('stats.accuracy compares the approved band with what each run billed', async ({ c }) => {
  const runs = [await planAndRun(c, ASK), await planAndRun(c, ASK), await planAndRun(c, CODE)];
  let inBand = 0;
  for (const r of runs) {
    const { lowUsd, highUsd } = r.plan.estimate.band;
    const cost = r.done.result.costUsd;
    if (cost >= lowUsd - 1e-9 && cost <= highUsd + 1e-9) inBand++;
  }
  const acc = await c.call<{
    runs: Record<string, number>;
    byTaskType: Array<{ label: string; samples: number }>;
    excluded: Record<string, number>;
  }>('stats.accuracy');
  expect(acc.runs['samples']).toBe(3);
  expect(acc.runs['inBand']).toBe(inBand);
  expect(acc.runs['inBand']! + acc.runs['below']! + acc.runs['above']!).toBe(3);
  const mean = runs.reduce((a, r) => a + r.done.result.costUsd, 0) / 3;
  expect(acc.runs['meanActualUsd']).toBeCloseTo(mean, 6);
  const mine = runs.reduce((a, r) => a + r.plan.estimate.expectedUsd, 0) / 3;
  expect(acc.runs['meanEstimateUsd']).toBeCloseTo(mine, 6);
  expect(acc.byTaskType.map((r) => r.label)).toEqual(expect.arrayContaining(['analysis', 'test']));
  expect(acc.excluded).toEqual({ cancelled: 0, notFinished: 0, noPlan: 0 });
  // The next estimate is shown with that record (R-402).
  const next = await c.call<Plan>('plan', { request: ASK, options: { isolated: false } });
  expect(next.estimate.accuracy).toMatch(
    new RegExp(`^past estimates here: ${inBand}/3 runs inside the band`),
  );
});
