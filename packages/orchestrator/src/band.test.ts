import { describe, expect, it } from 'vitest';
import { Journal } from '@kernelpai/journal';
import { HEURISTIC_SPREAD, outputSpread, quantile, stepBand, sumBands } from './band.js';
import { estimateGraph } from './estimate.js';
import { RoleAdapter, friendly, gnode, graph, setup } from './test-helpers/fakes.js';

const A = { provider: 'a', model: 'm' };

function journalWith(outs: number[], extra: Record<string, unknown> = {}) {
  const journal = Journal.open(':memory:');
  const sessionId = journal.startSession('band', '/');
  outs.forEach((out, i) => {
    const base = { sessionId, nodeId: 'n1', provider: 'a', model: 'm' };
    const requestId = `r${i}`;
    journal.append({ ...base, type: 'call', payload: { requestId, taskType: 'analysis' } });
    journal.append({
      ...base,
      type: 'response',
      payload: {
        requestId,
        outputTokens: out,
        usageBasis: 'reported',
        stopReason: 'end',
        ...extra,
      },
    });
  });
  return journal;
}

describe('quantile', () => {
  it('interpolates linearly and clamps q', () => {
    expect(quantile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    expect(quantile([10, 20], 0.25)).toBe(12.5);
    expect(quantile([5, 1, 3], -1)).toBe(1);
    expect(quantile([5, 1, 3], 2)).toBe(5);
  });
});

describe('outputSpread (R-302)', () => {
  it('learns low, median and high output per model and task type from the journal', () => {
    const j = journalWith([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]);
    const s = outputSpread(j)(A, 'analysis');
    expect(s).toEqual({ low: 200, median: 600, high: 1000, samples: 11 });
    expect(outputSpread(j)(A, 'code_generation')).toBeUndefined();
    expect(
      outputSpread(j, { window: 2, minSamples: 2, lowQuantile: 0, highQuantile: 1 })(A, 'analysis'),
    ).toEqual({ low: 1000, median: 1050, high: 1100, samples: 2 });
  });

  it('needs minSamples and ignores estimated, cancelled and unmatched responses', () => {
    expect(outputSpread(journalWith([10, 20]))(A, 'analysis')).toBeUndefined();
    expect(outputSpread(journalWith([10, 20]), { minSamples: 2 })(A, 'analysis')).toBeDefined();
    const est = journalWith([10, 20, 30], { usageBasis: 'estimated' });
    expect(outputSpread(est)(A, 'analysis')).toBeUndefined();
    const cancelled = journalWith([10, 20, 30], { stopReason: 'cancelled' });
    expect(outputSpread(cancelled)(A, 'analysis')).toBeUndefined();
    const zero = journalWith([0, 0, 0]);
    expect(outputSpread(zero)(A, 'analysis')).toBeUndefined();
    const j = Journal.open(':memory:');
    const sessionId = j.startSession('x', '/');
    j.append({
      sessionId,
      type: 'response',
      provider: 'a',
      model: 'm',
      payload: { requestId: 'z' },
    });
    j.append({ sessionId, type: 'response', payload: { outputTokens: 5 } });
    expect(outputSpread(j, { minSamples: 1 })(A, 'analysis')).toBeUndefined();
  });
});

describe('stepBand / sumBands', () => {
  const card = new RoleAdapter('a', friendly('A')).candidate.card;
  const estimate = {
    inputTokens: 1000,
    maxOutputTokens: 1000,
    maxCostUsd: 0.003,
    expectedCostUsd: 0.0015, // 1000 in × $1 + 250 out × $2 (per MTok)
    basis: 'heuristic' as const,
  };

  it('uses the heuristic spread around the expected output without history', () => {
    const b = stepBand(card, estimate, { min: 1, max: 3 }, undefined);
    expect(HEURISTIC_SPREAD).toEqual({ low: 0.5, high: 2 });
    expect(b.perCallLowUsd).toBeCloseTo(0.001 + 125 * 2e-6, 9);
    expect(b.perCallHighUsd).toBeCloseTo(0.001 + 500 * 2e-6, 9);
    expect(b).toMatchObject({ basis: 'heuristic', samples: 0 });
    expect(b.lowUsd).toBeCloseTo(b.perCallLowUsd, 9);
    expect(b.highUsd).toBeCloseTo(3 * b.perCallHighUsd, 9);
  });

  it('uses the calibration spread, clipped to the output cap', () => {
    const spread = { low: 100, median: 400, high: 5000, samples: 7 };
    const b = stepBand(card, estimate, { min: 0, max: 2 }, spread);
    expect(b.perCallLowUsd).toBeCloseTo(0.001 + 100 * 2e-6, 9);
    expect(b.perCallHighUsd).toBeCloseTo(0.001 + 1000 * 2e-6, 9);
    expect(b).toMatchObject({ basis: 'calibrated', samples: 7, lowUsd: 0 });
  });

  it('falls back to the expected cost without a card', () => {
    const b = stepBand(undefined, estimate, { min: 1, max: 1 }, undefined);
    expect(b.perCallLowUsd).toBe(0.0015);
    expect(b.perCallHighUsd).toBe(0.0015);
  });

  it('sums bands and marks a mixed basis', () => {
    const h = { lowUsd: 1, highUsd: 2, basis: 'heuristic' as const };
    const c = { lowUsd: 0.5, highUsd: 4, basis: 'calibrated' as const };
    expect(sumBands([h, c])).toEqual({ lowUsd: 1.5, highUsd: 6, basis: 'mixed' });
    expect(sumBands([c, c])).toEqual({ lowUsd: 1, highUsd: 8, basis: 'calibrated' });
    expect(sumBands([])).toEqual({ lowUsd: 0, highUsd: 0, basis: 'heuristic' });
  });
});

describe('estimateGraph band (R-302)', () => {
  const two = () =>
    setup([
      new RoleAdapter('a', friendly('A'), { analysis: 0.9, critique: 0.2 }),
      new RoleAdapter('b', friendly('B'), { analysis: 0.3, critique: 0.9 }),
    ]).options;

  it('gives each node and the total a band, keeping the existing fields', () => {
    const g = graph([gnode({ id: 'x' }), gnode({ id: 'y', protocol: 'author_critic' })]);
    const e = estimateGraph(g, two());
    for (const n of e.nodes) {
      expect(n.band.lowUsd).toBeLessThanOrEqual(n.minUsd);
      expect(n.band.highUsd).toBeGreaterThanOrEqual(n.expectedUsd);
      expect(n.band.basis).toBe('heuristic');
      expect(n.minUsd).toBeGreaterThan(0);
    }
    expect(e.band.lowUsd).toBeCloseTo(e.nodes[0]!.band.lowUsd + e.nodes[1]!.band.lowUsd, 6);
    expect(e.band.highUsd).toBeGreaterThan(e.totalUsd);
    expect(e.totalUsd).toBeGreaterThan(e.minUsd);
  });

  it('prices from history when a spread is given, per role task type', () => {
    const g = graph([gnode({ protocol: 'author_critic' })]);
    const j = journalWith([10, 10, 10, 1000, 1000]);
    const e = estimateGraph(g, { ...two(), spread: outputSpread(j) });
    const [author, critic] = e.nodes[0]!.steps;
    expect(author!.band.basis).toBe('calibrated'); // a/m on analysis has history
    expect(critic!.band.basis).toBe('heuristic'); // b/m on critique has none
    expect(e.nodes[0]!.band.basis).toBe('mixed');
    expect(e.band.basis).toBe('mixed');
    expect(author!.band.perCallHighUsd - author!.band.perCallLowUsd).toBeCloseTo(
      (1000 - 10) * 2e-6,
      9,
    );
  });
});
