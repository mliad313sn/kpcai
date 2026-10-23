import { refToString, type Candidate, type TaskNode } from '@kernelpai/core';
import { CompetenceRouter } from '@kernelpai/router';
import { describe, expect, it } from 'vitest';
import { gradeJournal } from './grades.js';
import { CompetenceStore, evidencePhrase } from './store.js';
import { Script } from './test-helpers/script.js';

const cand = (r: string, test: number): Candidate => {
  const [provider, model] = r.split('/') as [string, string];
  return {
    ref: { provider, model },
    providerKind: 'cloud',
    jurisdiction: 'US',
    card: {
      id: model,
      contextWindow: 200_000,
      maxOutput: 8_000,
      modalities: ['text', 'code'],
      price: { inputPerMTok: 1, outputPerMTok: 4 },
      latencyMsTypical: 1_000,
      competence: { test },
      strengths: [],
      weaknesses: [],
    },
  };
};
// b/m is the prior favourite for tests by a small margin.
const pool = [cand('a/m', 0.6), cand('b/m', 0.68), cand('c/critic', 0.1)];
const node: TaskNode = {
  id: 'n1',
  type: 'test',
  criticality: 'normal',
  messages: [{ role: 'user', content: 'Write unit tests for parse().' }],
};

/** `good` approved and `bad` rejected test tasks of `model`, reviewed by c/critic. */
function history(s: Script, model: string, good: number, bad: number): void {
  for (let i = 0; i < good + bad; i++) {
    s.authorCritic(`${model}-${i}`, { author: model, critic: 'c/critic', approve: i < good });
  }
}

const route = (s: Script, project = '/repo') =>
  new CompetenceRouter({ measured: CompetenceStore.fromJournal(s.j, { project }) }).route(
    node,
    pool,
  );

describe('CompetenceStore', () => {
  it('summarises grades per model and task type with the evidence the router cites', () => {
    const s = new Script();
    history(s, 'a/m', 14, 2);
    s.plan([{ id: 'n1', type: 'test' }]);
    s.answer('n1', 'a/m', 'author', 'tests', { taskType: 'test' });
    s.test('n1', 'a/m', 0);
    s.outcome('with-tests');
    const e = CompetenceStore.fromJournal(s.j).get({ provider: 'a', model: 'm' }, 'test');
    expect(e).toEqual({
      score: 15 / 17,
      samples: 17,
      evidence: 'approved 15/17 test tasks here (tests passed 1/1, critics approved 14/16)',
    });
    expect(
      CompetenceStore.fromJournal(s.j).get({ provider: 'a', model: 'm' }, 'analysis'),
    ).toBeUndefined();
  });

  it('is per repository and keeps only the most recent window', () => {
    const s = new Script('/repo');
    history(s, 'a/m', 0, 5);
    s.session('/elsewhere');
    history(s, 'a/m', 5, 0);
    const a = { provider: 'a', model: 'm' };
    expect(CompetenceStore.fromJournal(s.j, { project: '/repo/' }).get(a, 'test')?.score).toBe(0);
    expect(CompetenceStore.fromJournal(s.j, { project: '/elsewhere' }).get(a, 'test')?.score).toBe(
      1,
    );
    expect(CompetenceStore.fromJournal(s.j).get(a, 'test')?.samples).toBe(10);
    const recent = CompetenceStore.fromJournal(s.j, { window: 5 }).get(a, 'test');
    expect(recent).toMatchObject({ score: 1, samples: 5 });
    const entries = CompetenceStore.fromGrades(gradeJournal(s.j).grades).entries();
    expect(entries.map((e) => [refToString(e.ref), e.samples])).toEqual([['a/m', 10]]);
  });

  it('phrases evidence by type and its two strongest details', () => {
    expect(
      evidencePhrase({
        approved: 3,
        samples: 4,
        taskType: 'code_generation',
        signals: { rollback: { good: 0, total: 1 }, manual: { good: 2, total: 2 } },
      }),
    ).toBe('approved 3/4 code generation tasks here (1 rolled back, rated good 2/2)');
    expect(evidencePhrase({ approved: 0, samples: 1, taskType: 'test', signals: {} })).toBe(
      'approved 0/1 test tasks here',
    );
  });
});

describe('routing learns from outcomes in this repository (R-401)', () => {
  it('routing for the same task type changes after a scripted history, citing the evidence', () => {
    const s = new Script();
    const before = route(s);
    expect(refToString(before.chosen.ref)).toBe('b/m');
    expect(before.reason).not.toContain('evidence');
    history(s, 'a/m', 14, 2);
    history(s, 'b/m', 3, 7);
    const after = route(s);
    expect(refToString(after.chosen.ref)).toBe('a/m');
    expect(after.reason).toContain('evidence: approved 14/16 test tasks here');
    expect(after.reason).toContain('on measured competence');
    // in another repository the same history does not count
    expect(refToString(route(s, '/elsewhere').chosen.ref)).toBe('b/m');
  });

  it('does not move routing before the minimum number of graded tasks', () => {
    const s = new Script();
    history(s, 'a/m', 4, 0);
    history(s, 'b/m', 0, 4);
    const d = route(s);
    expect(refToString(d.chosen.ref)).toBe('b/m');
    expect(d.chosen.parts.measuredCompetence).toBeNull();
  });

  it('bounded updates: a burst of bad grades cannot flip a strong prior', () => {
    const s = new Script();
    const wide = [cand('a/m', 0.3), cand('b/m', 0.95), cand('c/critic', 0.1)];
    history(s, 'b/m', 0, 8);
    history(s, 'a/m', 8, 0);
    const store = CompetenceStore.fromJournal(s.j, { project: '/repo' });
    const d = new CompetenceRouter({ measured: store }).route(node, wide);
    expect(refToString(d.chosen.ref)).toBe('b/m');
  });

  it('is recomputed from the journal: a later manual grade changes the store', () => {
    const s = new Script();
    history(s, 'a/m', 5, 0);
    const a = { provider: 'a', model: 'm' };
    expect(CompetenceStore.fromJournal(s.j).get(a, 'test')?.score).toBe(1);
    s.note({
      action: 'grade',
      runId: 'a/m-0',
      nodeId: 'n1',
      grade: 'bad',
      author: 'alice',
      source: 'human',
    });
    expect(CompetenceStore.fromJournal(s.j).get(a, 'test')?.score).toBeCloseTo(0.8 + 0.2 * 0.25);
  });
});
