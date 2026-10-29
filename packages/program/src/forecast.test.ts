import { describe, expect, it } from 'vitest';
import { forecast, percentile, remainingRuns } from './forecast.js';
import type { ProgramState } from './schemas.js';
import { NOW, run, running } from './test-helpers/fixtures.js';

const at = (h: number): string => new Date(NOW.getTime() + h * 3_600_000).toISOString();

function settled(costs: number[], hours = 2): ProgramState {
  return {
    ...running(),
    runs: costs.map((c, i) =>
      run({
        runId: `s${i}`,
        wpId: i === 0 ? 'wp1' : `old${i}`,
        status: 'finished',
        costUsd: c,
        capUsd: 1.5,
        startedAt: NOW.toISOString(),
        settledAt: at(hours),
      }),
    ),
  };
}

describe('forecast from the band history', () => {
  it('interpolates percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([10, 0], 0.1)).toBeCloseTo(1);
  });

  it('gives no interval without a settled run, only the cap', () => {
    const f = forecast(running(), { now: NOW });
    expect(f.costUsd).toBeUndefined();
    expect(f.finish).toBeUndefined();
    // wp1, wp2 and the p1 review; wp3 and the p2 review.
    expect(f.remainingRuns).toBe(5);
    expect(f.capUsd).toBe(10);
  });

  it('uses the whole band seen so far while history is short', () => {
    const f = forecast(settled([0.4]), { now: NOW });
    expect(f.wide).toBe(true);
    // Spent 0.4; four runs left, each between 0.4 (cheapest cost) and 1.5 (highest band top).
    expect(f.remainingRuns).toBe(4);
    expect(f.costUsd!.low).toBeCloseTo(0.4 + 4 * 0.4);
    expect(f.costUsd!.high).toBeCloseTo(0.4 + 4 * 1.5);
    expect(f.finish).toEqual({ low: '2026-10-23', high: '2026-10-23' });
    expect(f.evidence).toEqual(['run:s0']);
  });

  it('uses an 80 % interval with five settled runs or more, and counts live runs to their band top', () => {
    const s = settled([0.1, 0.2, 0.3, 0.4, 0.5], 10);
    s.runs.push(run({ runId: 'live', wpId: 'wp2', capUsd: 0.9 }));
    const f = forecast(s, { now: NOW, concurrency: 2 });
    expect(f.wide).toBe(false);
    const lo = percentile([0.1, 0.2, 0.3, 0.4, 0.5], 0.1);
    const hi = percentile([0.1, 0.2, 0.3, 0.4, 0.5], 0.9);
    // Left: the p1 review, wp3, the p2 review (3 runs); live wp2 up to its band top.
    expect(f.remainingRuns).toBe(3);
    expect(f.costUsd!.low).toBeCloseTo(1.5 + lo + 3 * lo);
    expect(f.costUsd!.high).toBeCloseTo(1.5 + 0.9 + 3 * hi);
    // Two waves of 10 h at two at a time, plus the live run's wave at the high end.
    expect(f.finish).toEqual({ low: '2026-10-24', high: '2026-10-24' });
    expect(f.answersIncluded).toBe(false);
    const withAnswers = forecast(s, { now: NOW, concurrency: 2, answerHours: [24, 48] });
    expect(withAnswers.answersIncluded).toBe(true);
    expect(withAnswers.finish!.high > f.finish!.high).toBe(true);
  });

  it('leaves nothing to do once delivered or stopped', () => {
    expect(remainingRuns({ ...running(), status: 'delivered' })).toBe(0);
    expect(forecast({ ...settled([1]), status: 'stopped' }, { now: NOW }).costUsd).toEqual({
      low: 1,
      high: 1,
    });
  });
});
