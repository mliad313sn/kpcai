import { refToString, type ModelRef, type TaskType } from '@kernelpai/core';
import { describe, expect, it } from 'vitest';
import {
  CompetenceRouter,
  DEFAULT_COST_REFERENCE_USD,
  DEFAULT_LATENCY_REFERENCE_MS,
} from './router.js';
import { cand, node } from './test-helpers/fixtures.js';

const order = (r: CompetenceRouter, pool: Parameters<CompetenceRouter['route']>[1]): string[] => {
  const d = r.route(node(), pool);
  return [d.chosen, ...d.fallbacks].map((x) => refToString(x.ref));
};

describe('CompetenceRouter absolute references (F6)', () => {
  // Expected output 2000 tokens (cap 8000 / 4): output price drives the expected cost.
  const pool = [
    cand('a/cheap-weak', {
      price: { inputPerMTok: 0, outputPerMTok: 1 },
      competence: { code_generation: 0.6 },
      latencyMsTypical: 4_000,
    }),
    cand('b/mid-strong', {
      price: { inputPerMTok: 0, outputPerMTok: 10 },
      competence: { code_generation: 0.66 },
      latencyMsTypical: 1_000,
    }),
    cand('c/pricier-strongest', {
      price: { inputPerMTok: 0, outputPerMTok: 20 },
      competence: { code_generation: 0.7 },
      latencyMsTypical: 2_000,
    }),
  ];
  const giant = cand('z/giant', {
    price: { inputPerMTok: 500, outputPerMTok: 5_000 },
    competence: { code_generation: 0.1 },
    latencyMsTypical: 600_000,
  });

  it('IIA: an expensive, slow extra candidate does not reorder the others', () => {
    for (const profile of ['economy', 'balanced', 'performance'] as const) {
      const r = new CompetenceRouter({ profile });
      const before = order(r, pool);
      const after = order(r, [...pool, giant]).filter((x) => x !== 'z/giant');
      expect(after).toEqual(before);
      const scores = (p: typeof pool): Record<string, number> => {
        const d = r.route(node(), p);
        const all = [d.chosen, ...d.fallbacks].filter((x) => x.ref.provider !== 'z');
        return Object.fromEntries(all.map((x) => [refToString(x.ref), x.score]));
      };
      expect(scores([...pool, giant])).toEqual(scores(pool));
    }
  });

  it('penalty = min(1, expected / reference) without a node budget', () => {
    const r = new CompetenceRouter();
    expect(r.costReferenceUsd).toBe(DEFAULT_COST_REFERENCE_USD);
    expect(r.latencyReferenceMs).toBe(DEFAULT_LATENCY_REFERENCE_MS);
    const d = r.route(node(), [pool[1]!]);
    const expected = d.chosen.estimate.expectedCostUsd;
    expect(d.chosen.parts.costPenalty).toBeCloseTo(expected / 0.1, 9);
    expect(d.chosen.parts.latencyPenalty).toBeCloseTo(1_000 / 20_000, 9);
    const g = r.route(node(), [giant]);
    expect(g.chosen.parts.costPenalty).toBe(1);
    expect(g.chosen.parts.latencyPenalty).toBe(1);
  });

  it('tiny absolute differences get a tiny penalty, not the full weight', () => {
    const r = new CompetenceRouter();
    const d = r.route(node(), [
      cand('a/free', { price: { inputPerMTok: 0, outputPerMTok: 0 } }),
      cand('b/tiny', { price: { inputPerMTok: 0, outputPerMTok: 0.01 } }),
    ]);
    const tiny = [d.chosen, ...d.fallbacks].find((x) => x.ref.provider === 'b')!;
    expect(tiny.parts.costPenalty).toBeLessThan(0.001);
  });

  it('a node budget and latency cap override the references', () => {
    const r = new CompetenceRouter({ costReferenceUsd: 1, latencyReferenceMs: 1_000 });
    const d = r.route(node({ budgetUsd: 0.04, maxLatencyMs: 4_000 }), [pool[1]!]);
    expect(d.chosen.parts.costPenalty).toBeCloseTo(0.02 / 0.04, 6);
    expect(d.chosen.parts.latencyPenalty).toBe(0.25);
    const own = r.route(node(), [pool[1]!]);
    expect(own.chosen.parts.costPenalty).toBeCloseTo(0.02, 6);
    expect(own.chosen.parts.latencyPenalty).toBe(1);
  });

  it('rejects non-positive references', () => {
    expect(() => new CompetenceRouter({ costReferenceUsd: 0 })).toThrow(RangeError);
    expect(() => new CompetenceRouter({ latencyReferenceMs: Number.NaN })).toThrow(
      /latencyReferenceMs must be > 0/,
    );
  });
});

describe('CompetenceRouter calibration hook', () => {
  const pricey = { price: { inputPerMTok: 0, outputPerMTok: 50 } };

  it('passes calibrated output tokens per candidate and task type to the estimate', () => {
    const seen: string[] = [];
    const expectedOutput = (ref: ModelRef, type: TaskType): number | undefined => {
      seen.push(`${refToString(ref)}:${type}`);
      return ref.provider === 'a' ? 100 : undefined;
    };
    const r = new CompetenceRouter({ expectedOutput });
    const d = r.route(node({ type: 'analysis' }), [cand('a/m', pricey), cand('b/m', pricey)]);
    expect(seen.sort()).toEqual(['a/m:analysis', 'b/m:analysis']);
    const a = [d.chosen, ...d.fallbacks].find((x) => x.ref.provider === 'a')!;
    const b = [d.chosen, ...d.fallbacks].find((x) => x.ref.provider === 'b')!;
    expect(a.estimate.basis).toBe('calibrated');
    expect(a.estimate.expectedCostUsd).toBeCloseTo((100 * 50) / 1e6, 9);
    expect(b.estimate.basis).toBe('heuristic');
    expect(b.estimate.expectedCostUsd).toBeCloseTo((2_000 * 50) / 1e6, 9);
  });

  it('calibrated output feeds the cost penalty and can change the choice', () => {
    const pool = [
      cand('a/strong-verbose', { ...pricey, strengths: ['code_generation'] }),
      cand('b/plain-free', { price: { inputPerMTok: 0, outputPerMTok: 0 } }),
    ];
    const heuristic = new CompetenceRouter({ profile: 'economy' }).route(node(), pool);
    expect(refToString(heuristic.chosen.ref)).toBe('b/plain-free');
    const calibrated = new CompetenceRouter({
      profile: 'economy',
      expectedOutput: (ref) => (ref.provider === 'a' ? 20 : undefined),
    }).route(node(), pool);
    expect(refToString(calibrated.chosen.ref)).toBe('a/strong-verbose');
    expect(calibrated.chosen.parts.costPenalty).toBeCloseTo((20 * 50) / 1e6 / 0.1, 9);
  });
});
