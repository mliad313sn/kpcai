import { describe, expect, it } from 'vitest';
import { accuracyNote, estimateAccuracy } from './accuracy.js';
import { Script } from './test-helpers/script.js';

type Basis = 'calibrated' | 'heuristic' | 'mixed';

/** A planned run of one node of `type` estimated at `est` in [low, high], billed `actual`. */
function run(
  s: Script,
  id: string,
  o: { type: string; est: number; low: number; high: number; actual: number; basis?: Basis },
  outcome: { status?: string; cancelled?: boolean } = {},
): void {
  const band = { lowUsd: o.low, highUsd: o.high, basis: o.basis ?? 'calibrated' };
  s.plan([{ id: 'n1', type: o.type }], {
    expectedUsd: o.est,
    totalUsd: o.est,
    capUsd: o.high,
    band,
    nodes: [{ nodeId: 'n1', expectedUsd: o.est, band }],
  });
  s.answer('n1', 'a/m', 'author', 'x', { taskType: o.type, costUsd: o.actual });
  s.outcome(id, outcome.status ?? 'finished', outcome.cancelled ?? false);
}

describe('estimate accuracy (R-402)', () => {
  it('reports estimate vs actual per task type with the share inside the band', () => {
    const s = new Script();
    run(s, 'r1', { type: 'test', est: 0.1, low: 0.05, high: 0.2, actual: 0.08 });
    run(s, 'r2', { type: 'test', est: 0.1, low: 0.05, high: 0.2, actual: 0.3 });
    run(s, 'r3', {
      type: 'analysis',
      est: 0.02,
      low: 0.01,
      high: 0.04,
      actual: 0.02,
      basis: 'heuristic',
    });
    run(s, 'r4', {
      type: 'analysis',
      est: 0.02,
      low: 0.01,
      high: 0.04,
      actual: 0.005,
      basis: 'heuristic',
    });
    const r = estimateAccuracy(s.j);
    expect(r.runs).toMatchObject({ samples: 4, inBand: 2, above: 1, below: 1, inBandRate: 0.5 });
    const test = r.byTaskType.find((x) => x.label === 'test');
    expect(test).toMatchObject({
      samples: 2,
      inBand: 1,
      above: 1,
      meanEstimateUsd: 0.1,
      meanActualUsd: 0.19,
    });
    // (0.1 − 0.08)/0.08 = +25 %, (0.1 − 0.3)/0.3 = −66.67 %
    expect(test?.meanSignedErrorPct).toBeCloseTo((25 - 66.6667) / 2, 2);
    expect(test?.meanAbsErrorPct).toBeCloseTo((25 + 66.6667) / 2, 2);
    expect(r.byBasis.map((b) => [b.label, b.samples, b.inBand])).toEqual([
      ['calibrated', 2, 1],
      ['cold-start', 2, 1],
    ]);
  });

  it('leaves out cancelled, unfinished and unplanned runs, and other projects', () => {
    const s = new Script();
    run(s, 'ok', { type: 'test', est: 0.1, low: 0.05, high: 0.2, actual: 0.1 });
    run(
      s,
      'cx',
      { type: 'test', est: 0.1, low: 0.05, high: 0.2, actual: 0.01 },
      { cancelled: true },
    );
    run(
      s,
      'nr',
      { type: 'test', est: 0.1, low: 0.05, high: 0.2, actual: 0 },
      { status: 'not_run' },
    );
    s.answer('n1', 'a/m', 'author', 'unplanned', { costUsd: 0.5 });
    s.outcome('np');
    s.session('/other');
    run(s, 'el', { type: 'test', est: 0.1, low: 0.05, high: 0.2, actual: 1 });
    const r = estimateAccuracy(s.j, { project: '/repo' });
    expect(r.runs.samples).toBe(1);
    expect(r.excluded).toEqual({ cancelled: 1, notFinished: 1, noPlan: 1 });
    expect(estimateAccuracy(s.j).runs.samples).toBe(2);
  });

  it('gives one line to show next to an estimate before launch', () => {
    const s = new Script();
    expect(accuracyNote(estimateAccuracy(s.j))).toMatch(/no finished run yet/);
    run(s, 'r1', { type: 'test', est: 0.1, low: 0.05, high: 0.2, actual: 0.1, basis: 'heuristic' });
    run(s, 'r2', { type: 'test', est: 0.1, low: 0.05, high: 0.2, actual: 0.5 });
    expect(accuracyNote(estimateAccuracy(s.j), ['test', 'writing'])).toBe(
      'past estimates here: 1/2 runs inside the band (50 %); test: 1/2; cold start 1/1',
    );
  });

  it('copes with malformed or free estimates', () => {
    const s = new Script();
    s.plan([{ id: 'n1', type: 'test' }], { nodes: 'nope' });
    s.outcome('bad');
    run(s, 'free', { type: 'test', est: 0, low: 0, high: 0, actual: 0 });
    const r = estimateAccuracy(s.j);
    expect(r.runs).toMatchObject({ samples: 1, inBand: 1, meanAbsErrorPct: null });
  });
});
