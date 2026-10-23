import type { ChatRequest, ModelCard, Price, Usage } from './schemas.js';

/** Default output cap when a request does not set one. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/** Fixed per-message overhead (role markers, separators). */
const MESSAGE_OVERHEAD_TOKENS = 4;

export interface CostEstimate {
  inputTokens: number;
  /** Upper bound: the request's output cap, clipped to the model's maximum. */
  maxOutputTokens: number;
  /** Cost if the model used its full output cap. */
  maxCostUsd: number;
  /** Cost for a typical answer (a quarter of the cap, at least 256 tokens). */
  expectedCostUsd: number;
  basis: 'heuristic';
}

/**
 * Rough token count: ~4 characters per token for prose and code.
 * Phase 1 replaces this with provider token counters where available (ADR-0005).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function costUsd(price: Price, usage: Usage): number {
  const raw =
    (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1e6;
  return Math.round(raw * 1e6) / 1e6;
}

export function estimateRequest(req: ChatRequest, card: ModelCard): CostEstimate {
  const inputTokens = req.messages.reduce(
    (sum, m) => sum + estimateTokens(m.content) + MESSAGE_OVERHEAD_TOKENS,
    0,
  );
  const cap = Math.min(req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, card.maxOutput);
  const expectedOut = Math.min(cap, Math.max(256, Math.ceil(cap / 4)));
  return {
    inputTokens,
    maxOutputTokens: cap,
    maxCostUsd: costUsd(card.price, { inputTokens, outputTokens: cap }),
    expectedCostUsd: costUsd(card.price, { inputTokens, outputTokens: expectedOut }),
    basis: 'heuristic',
  };
}

export function formatUsd(amount: number): string {
  if (amount === 0) return '$0';
  if (amount < 0.01) return `$${Number(amount.toPrecision(2))}`;
  return `$${amount.toFixed(2)}`;
}
