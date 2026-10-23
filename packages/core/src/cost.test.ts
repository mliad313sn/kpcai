import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  costUsd,
  estimateRequest,
  estimateTokens,
  formatUsd,
} from './cost.js';
import { ModelCardSchema } from './schemas.js';

const card = ModelCardSchema.parse({
  id: 'm',
  contextWindow: 100_000,
  maxOutput: 8_000,
  modalities: ['text'],
  price: { inputPerMTok: 4, outputPerMTok: 20 },
});

describe('cost', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('computes cost from usage and price', () => {
    expect(costUsd(card.price, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(4);
    expect(costUsd(card.price, { inputTokens: 1000, outputTokens: 1000 })).toBeCloseTo(0.024, 6);
  });

  it('clips the output cap to the model maximum', () => {
    const est = estimateRequest(
      { model: 'm', messages: [{ role: 'user', content: 'x'.repeat(400) }] },
      card,
    );
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBeGreaterThan(card.maxOutput);
    expect(est.maxOutputTokens).toBe(8_000);
    expect(est.inputTokens).toBe(104);
    expect(est.maxCostUsd).toBeCloseTo((104 * 4 + 8000 * 20) / 1e6, 6);
    expect(est.expectedCostUsd).toBeLessThan(est.maxCostUsd);
    expect(est.basis).toBe('heuristic');
  });

  it('honours a small explicit cap', () => {
    const est = estimateRequest(
      { model: 'm', maxOutputTokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      card,
    );
    expect(est.maxOutputTokens).toBe(100);
    expect(est.expectedCostUsd).toBe(est.maxCostUsd);
  });

  it('formats amounts for humans', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.000021)).toBe('$0.000021');
    expect(formatUsd(0.4)).toBe('$0.40');
  });
});
