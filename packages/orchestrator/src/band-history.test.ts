import { describe, expect, it } from 'vitest';
import { HEURISTIC_MAX_RATIO, HEURISTIC_TOOL_ROUNDS, outputSpread, stepBand } from './band.js';
import { history } from './test-helpers/band-history.js';
import { RoleAdapter, friendly } from './test-helpers/fakes.js';

const A = { provider: 'a', model: 'm' };

describe('outputSpread per role', () => {
  it("prefers the role's own history and falls back to the task type's", () => {
    const j = history([
      ...[10, 12, 14].map((out) => ({ out, role: 'critic' })),
      ...[500, 600, 700].map((out) => ({ out, role: 'author' })),
    ]);
    const s = outputSpread(j, { lowQuantile: 0, highQuantile: 1 });
    expect(s(A, 'analysis', 'critic')).toMatchObject({ low: 10, high: 14, samples: 3 });
    expect(s(A, 'analysis', 'author')).toMatchObject({ low: 500, high: 700 });
    expect(s(A, 'analysis', 'judge')).toMatchObject({ low: 10, high: 700, samples: 6 });
    expect(s(A, 'analysis')).toMatchObject({ samples: 6 });
  });
});

describe('outputSpread input ratio', () => {
  it('learns reported ÷ estimated input tokens per model, across task types', () => {
    const j = history([
      { out: 5, input: 90 },
      { out: 5, input: 110, type: 'writing' },
      { out: 5, input: 120 },
    ]);
    const s = outputSpread(j, { lowQuantile: 0, highQuantile: 1, minSamples: 2 });
    expect(s(A, 'analysis')?.inputRatio).toEqual({ low: 0.9, high: 1.2 });
    expect(s(A, 'writing')).toBeUndefined(); // one output sample only
  });
});

describe('outputSpread tool rounds', () => {
  it('learns rounds per step, tool results and tool-call turns from tool-offered calls', () => {
    const j = history([
      { out: 300, tools: true },
      { out: 300, tools: true },
      { out: 30, tools: true, stop: 'tool_use' },
      { out: 300, tools: true, round: 1, result: 400 },
      { out: 30, tools: true, stop: 'tool_use' },
      { out: 300, tools: true, round: 1, result: 400 },
      { out: 999, tools: false }, // not offered tools: not a tool step
    ]);
    const s = outputSpread(j)(A, 'analysis');
    // 4 steps offered tools, 2 reached round 1 → P(≥1) = 0.5: low 0, high 1.
    expect(s?.toolRounds).toEqual({
      low: 0,
      high: 1,
      resultTokens: 100,
      callTokens: 30,
      samples: 4,
    });
    // tool-call turns are not answers: the output spread is the answers'
    expect(s).toMatchObject({ samples: 5 });
    expect(s?.low).toBe(300);
  });

  it('needs minSamples tool-offered steps; every step using a tool raises the low', () => {
    expect(
      outputSpread(history([{ out: 9 }, { out: 9 }, { out: 9 }]))(A, 'analysis'),
    ).not.toHaveProperty('toolRounds');
    const always = [0, 1, 2].flatMap(() => [
      { out: 5, tools: true, stop: 'tool_use' },
      { out: 50, tools: true, round: 1, result: 40 },
    ]);
    expect(outputSpread(history(always))(A, 'analysis')?.toolRounds).toMatchObject({
      low: 1,
      high: 1,
      samples: 3,
    });
  });
});

describe('stepBand input range and tool rounds', () => {
  const card = new RoleAdapter('a', friendly('A')).candidate.card;
  const estimate = {
    inputTokens: 1000,
    maxOutputTokens: 1000,
    maxCostUsd: 0.003,
    expectedCostUsd: 0.0015,
    basis: 'heuristic' as const,
  };
  const spread = { low: 100, median: 200, high: 400, samples: 5, inputRatio: { low: 1, high: 1 } };

  it('prices the low and high input of a call', () => {
    const input = { tokens: { low: 500, high: 3000 }, calibrated: true, tools: false };
    const b = stepBand(card, estimate, { min: 1, max: 2 }, spread, input);
    expect(b.perCallLowUsd).toBeCloseTo(500e-6 + 100 * 2e-6, 9);
    expect(b.perCallHighUsd).toBeCloseTo(3000e-6 + 400 * 2e-6, 9);
    expect(b).toMatchObject({ basis: 'calibrated', outputTokens: { low: 100, high: 400 } });
    const guessed = stepBand(card, estimate, { min: 1, max: 1 }, spread, {
      ...input,
      calibrated: false,
    });
    expect(guessed.basis).toBe('mixed');
  });

  it('adds tool rounds: n tool-call turns, a growing conversation, then the answer', () => {
    const rounds = { low: 0, high: 2, resultTokens: 100, callTokens: 50, samples: 4 };
    const input = { tokens: { low: 1000, high: 1000 }, calibrated: true, tools: true };
    const b = stepBand(
      card,
      estimate,
      { min: 1, max: 1 },
      { ...spread, toolRounds: rounds },
      input,
    );
    // 3 calls × 1000 in + (1 + 2) × (50 + 100) grown; 2 × 50 + 400 out
    expect(b.perCallHighUsd).toBeCloseTo((3000 + 450) * 1e-6 + 500 * 2e-6, 9);
    expect(b.perCallLowUsd).toBeCloseTo(1000e-6 + 100 * 2e-6, 9);
    expect(b.basis).toBe('calibrated');
    // heuristic rounds (1 here): uncapped when the expected cost is as high
    const big = stepBand(card, estimate, { min: 1, max: 1 }, spread, input, 1);
    expect(big.basis).toBe('mixed'); // learned output, heuristic rounds
    const h = HEURISTIC_TOOL_ROUNDS;
    const n = h.high;
    const inTok = (n + 1) * 1000 + ((n * (n + 1)) / 2) * (h.callTokens + h.resultTokens);
    const outTok = n * h.callTokens + 400;
    expect(big.perCallHighUsd).toBeCloseTo(inTok * 1e-6 + outTok * 2e-6, 9);
    expect(big.perCallUsd).toBe(big.perCallHighUsd); // expected kept inside the band
    // ... and at most HEURISTIC_MAX_RATIO × the expected cost otherwise
    const cold = stepBand(card, estimate, { min: 1, max: 1 }, spread, input, 0.0012);
    expect(cold.perCallUsd).toBe(0.0012);
    expect(cold.perCallHighUsd).toBeCloseTo(HEURISTIC_MAX_RATIO * 0.0012, 9);
  });

  it('keeps the expected cost inside the band and never caps a calibrated step', () => {
    const input = { tokens: { low: 1000, high: 1000 }, calibrated: true, tools: false };
    const low = stepBand(card, estimate, { min: 1, max: 1 }, spread, input, 0);
    expect(low.perCallUsd).toBe(low.perCallLowUsd);
    const tiny = stepBand(card, estimate, { min: 1, max: 1 }, spread, input, 1e-9);
    expect(tiny.basis).toBe('calibrated');
    expect(tiny.perCallHighUsd).toBeCloseTo(1000e-6 + 400 * 2e-6, 9);
  });
});
