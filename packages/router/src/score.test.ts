import { describe, expect, it } from 'vitest';
import {
  blendMeasured,
  contributions,
  costPenalty,
  latencyPenalty,
  scoreParts,
  staticCompetence,
  sumContributions,
} from './score.js';
import { PROFILE_WEIGHTS, weightsFor } from './weights.js';
import { card } from './test-helpers/fixtures.js';

describe('staticCompetence', () => {
  it('uses the prior when the card sets one', () => {
    expect(staticCompetence(card({ competence: { writing: 0.9 } }), 'writing')).toBe(0.9);
  });
  it('falls back to 0.5 shifted by strengths and weaknesses', () => {
    expect(staticCompetence(card(), 'writing')).toBe(0.5);
    expect(staticCompetence(card({ strengths: ['writing'] }), 'writing')).toBe(0.75);
    expect(staticCompetence(card({ weaknesses: ['writing'] }), 'writing')).toBe(0.25);
    expect(staticCompetence(card({ strengths: ['test'], weaknesses: ['test'] }), 'test')).toBe(0.5);
  });
  it('prior overrides strengths', () => {
    const c = card({ competence: { test: 0.2 }, strengths: ['test'] });
    expect(staticCompetence(c, 'test')).toBe(0.2);
  });
});

describe('blendMeasured', () => {
  it('returns the prior without samples', () => {
    expect(blendMeasured(0.4, undefined)).toBe(0.4);
    expect(blendMeasured(0.4, { score: 1, samples: 0 })).toBe(0.4);
  });
  it('weighs measured and prior equally at 10 samples and trusts many samples', () => {
    expect(blendMeasured(0.4, { score: 0.8, samples: 10 })).toBeCloseTo(0.6);
    expect(blendMeasured(0.4, { score: 0.8, samples: 990 })).toBeCloseTo(0.796);
  });
  it('clamps out-of-range measured scores', () => {
    expect(blendMeasured(0, { score: 5, samples: 10 })).toBeCloseTo(0.5);
  });
});

describe('penalties', () => {
  it('cost is expected/budget capped at 1, zero budget penalises paid calls', () => {
    expect(costPenalty(0.05, 0.1)).toBe(0.5);
    expect(costPenalty(1, 0.1)).toBe(1);
    expect(costPenalty(0.01, 0)).toBe(1);
    expect(costPenalty(0, 0)).toBe(0);
  });
  it('latency is typical/max capped, unknown is neutral', () => {
    expect(latencyPenalty(500, 2_000)).toBe(0.25);
    expect(latencyPenalty(5_000, 2_000)).toBe(1);
    expect(latencyPenalty(undefined, 2_000)).toBe(0.5);
    expect(latencyPenalty(500, 0)).toBe(0);
  });
});

describe('scoreParts / contributions', () => {
  it('computes the spec §5.3 formula', () => {
    const parts = scoreParts({
      card: card({ competence: { analysis: 0.8 }, latencyMsTypical: 1_000 }),
      type: 'analysis',
      expectedCostUsd: 0.025,
      budgetUsd: 0.1,
      maxLatencyMs: 4_000,
      measured: { score: 0.6, samples: 10 },
    });
    expect(parts).toEqual({
      staticCompetence: 0.8,
      measuredCompetence: 0.6,
      costPenalty: 0.25,
      latencyPenalty: 0.25,
    });
    const w = PROFILE_WEIGHTS.balanced;
    const c = contributions(parts, w, { score: 0.6, samples: 10 });
    expect(sumContributions(c)).toBeCloseTo(0.4 * 0.8 + 0.25 * 0.7 - 0.2 * 0.25 - 0.15 * 0.25);
  });
  it('reports measured as null without samples', () => {
    const parts = scoreParts({
      card: card(),
      type: 'analysis',
      expectedCostUsd: 0,
      budgetUsd: 1,
      maxLatencyMs: 1,
    });
    expect(parts.measuredCompetence).toBeNull();
  });
});

describe('weightsFor', () => {
  it('returns presets and applies overrides', () => {
    expect(weightsFor()).toEqual(PROFILE_WEIGHTS.balanced);
    expect(weightsFor('economy', { latency: 0 }).latency).toBe(0);
  });
  it('rejects negative or non-finite weights', () => {
    expect(() => weightsFor('balanced', { cost: -1 })).toThrow(RangeError);
    expect(() => weightsFor('balanced', { cost: Number.NaN })).toThrow(RangeError);
  });
  it('profiles order cost weight economy > balanced > performance', () => {
    const { economy, balanced, performance } = PROFILE_WEIGHTS;
    expect(economy.cost).toBeGreaterThan(balanced.cost);
    expect(balanced.cost).toBeGreaterThan(performance.cost);
    expect(performance.competenceStatic).toBeGreaterThan(economy.competenceStatic);
  });
});
