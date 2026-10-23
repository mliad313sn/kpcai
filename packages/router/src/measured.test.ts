import { refToString, type MeasuredCompetence, type ModelRef } from '@kernelpai/core';
import { describe, expect, it } from 'vitest';
import { CompetenceRouter } from './router.js';
import { MAX_EVIDENCE_CHARS } from './reason.js';
import { MIN_MEASURED_SAMPLES } from './score.js';
import { cand, node, syntheticCandidates } from './test-helpers/fixtures.js';

type Sample = { score: number; samples: number; evidence?: string };

const store = (table: Record<string, Sample>): MeasuredCompetence => ({
  get: (ref: ModelRef) => table[refToString(ref)],
});

// Two close cards: b is the prior favourite by 0.05 of static competence.
const pool = [
  cand('a/m', { competence: { test: 0.6 } }),
  cand('b/m', { competence: { test: 0.65 } }),
];
const testNode = node({ type: 'test' });

describe('measured competence in routing (ADR-0028)', () => {
  it('changes routing only once the evidence reaches the minimum sample count', () => {
    const chosenAfter = (n: number): string => {
      const good = Math.round(n * 0.95);
      const r = new CompetenceRouter({
        measured: store({
          'a/m': { score: good / n, samples: n, evidence: `approved ${good}/${n} test tasks here` },
          'b/m': { score: 0.2, samples: n, evidence: `approved 0/${n} test tasks here` },
        }),
      });
      return refToString(r.route(testNode, pool).chosen.ref);
    };
    expect(chosenAfter(1)).toBe('b/m');
    expect(chosenAfter(MIN_MEASURED_SAMPLES - 1)).toBe('b/m');
    expect(chosenAfter(16)).toBe('a/m');
  });

  it('cites the evidence of the chosen model in its one-line reason', () => {
    const r = new CompetenceRouter({
      measured: store({
        'a/m': { score: 0.875, samples: 16, evidence: 'approved 14/16 test tasks here' },
        'b/m': { score: 0.3, samples: 10, evidence: 'approved 3/10 test tasks here' },
      }),
    });
    const d = r.route(testNode, pool);
    expect(refToString(d.chosen.ref)).toBe('a/m');
    expect(d.reason).toContain('measured competence');
    expect(d.reason).toMatch(/evidence: approved 14\/16 test tasks here$/);
    expect(d.reason).not.toContain('\n');
  });

  it('does not cite evidence that is not in force, and keeps the line bounded', () => {
    const thin = new CompetenceRouter({
      measured: store({
        'b/m': { score: 1, samples: 2, evidence: 'approved 2/2 test tasks here' },
      }),
    });
    expect(thin.route(testNode, pool).reason).not.toContain('evidence');
    const noisy = new CompetenceRouter({
      measured: store({ 'b/m': { score: 1, samples: 40, evidence: `x\ny ${'z'.repeat(400)}` } }),
    });
    const reason = noisy.route(testNode, pool).reason;
    expect(reason).not.toContain('\n');
    const cited = reason.slice(reason.indexOf('evidence: ') + 'evidence: '.length);
    expect(cited.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
  });

  it('a handful of perfect grades cannot overturn a large prior gap', () => {
    const wide = [
      cand('a/m', { competence: { test: 0.3 } }),
      cand('b/m', { competence: { test: 0.9 } }),
    ];
    const r = new CompetenceRouter({
      measured: store({ 'a/m': { score: 1, samples: 8 }, 'b/m': { score: 0, samples: 8 } }),
    });
    expect(refToString(r.route(testNode, wide).chosen.ref)).toBe('b/m');
  });

  it('stays under the latency budget with a measured store on 50 and 1000 models', () => {
    for (const n of [50, 1000]) {
      const cands = syntheticCandidates(n);
      const table = new Map(
        cands.map((c, i) => [
          refToString(c.ref),
          { score: (i % 10) / 10, samples: 5 + (i % 30), evidence: `approved ${i % 9}/9 here` },
        ]),
      );
      const r = new CompetenceRouter({ measured: { get: (ref) => table.get(refToString(ref)) } });
      const times: number[] = [];
      for (let i = 0; i < 200; i++) times.push(r.route(node({ id: `n${i}` }), cands).elapsedMs);
      times.sort((x, y) => x - y);
      const p95 = times[Math.floor(times.length * 0.95)] as number;
      expect(p95).toBeLessThan(50);
    }
  });
});
