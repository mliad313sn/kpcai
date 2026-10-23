import { costUsd, type CostEstimate, type ModelCard } from '@kernelpai/core';
import type { OutputSpread, ToolRounds } from './band-history.js';

export {
  outputSpread,
  quantile,
  type OutputSpread,
  type OutputSpreadOptions,
  type SpreadFn,
  type ToolRounds,
} from './band-history.js';

export type BandBasis = 'calibrated' | 'heuristic' | 'mixed';

/** A low–high cost range (R-302). */
export interface CostBand {
  lowUsd: number;
  highUsd: number;
  /** `calibrated`: every step priced from history; `heuristic`: none; `mixed`: some. */
  basis: BandBasis;
}

/** A token count range (an output, or the input of one call). */
export interface TokenRange {
  low: number;
  high: number;
}

export interface StepBand extends CostBand {
  perCallLowUsd: number;
  perCallHighUsd: number;
  /** History samples behind the spread (0 when heuristic). */
  samples: number;
  /** Output tokens of one call, low and high (clipped to the output cap). */
  outputTokens: TokenRange;
  /** Expected cost of one call, kept within the per-call band (low ≤ expected ≤ high). */
  perCallUsd: number;
}

/**
 * Cold-start factors (no history; the band says `basis: heuristic`):
 * - output: 1 % to 2× the expected output (itself a quarter of the output cap). The low end
 *   is near zero on purpose: a short verdict, a vote or a mock echo is 1–5 % of a quarter
 *   cap, and an honest low is "about the prompt alone".
 * - text read from another step (dependency context, the work a critic reads) uses the
 *   same factors around the dependency allowance (4,000 tokens by default).
 */
export const HEURISTIC_SPREAD = { low: 0.01, high: 2 } as const;

/**
 * Cold-start error of the input estimate (4 characters a token): real tokenizers count
 * 0.8× (plain English) to 1.25× (code, other scripts) as many. Learned per model from the
 * journal's estimated vs reported input tokens.
 */
export const HEURISTIC_INPUT_RATIO = { low: 0.8, high: 1.25 } as const;

/**
 * Cold-start tool rounds of a step whose node lists tools: up to 1 extra round, a
 * 200-token tool-call turn answered by 1,000 tokens of tool results. Learned from the
 * journal once the model has been offered tools on the task type `minSamples` times.
 */
export const HEURISTIC_TOOL_ROUNDS: ToolRounds = {
  low: 0,
  high: 1,
  resultTokens: 1000,
  callTokens: 200,
  samples: 0,
};

/**
 * Without full history, a step's per-call high is at most this multiple of its expected
 * per-call cost (D-021 makes the high the approval figure and the hard cap; a cold-start
 * cap far above the likely cost carries no information). Calibrated steps are not capped.
 */
export const HEURISTIC_MAX_RATIO = 3;

/** What one call of a step reads, and whether it may loop on tools. */
export interface StepInput {
  /** Input tokens of the first call: low and high context/work around the prompt. */
  tokens: TokenRange;
  /** The context and work it reads were sized from history (else heuristic). */
  calibrated: boolean;
  /** The node lists tools: count tool rounds. */
  tools: boolean;
}

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const NO_ROUNDS: ToolRounds = { low: 0, high: 0, resultTokens: 0, callTokens: 0, samples: 0 };

/**
 * Cost of one step call with `n` tool rounds: n tool-call turns, then the answer. Round j
 * re-sends the conversation, grown by j × (tool-call turn + tool results).
 */
function withRounds(card: ModelCard, input: number, output: number, n: number, t: ToolRounds) {
  const call = Math.min(output, t.callTokens);
  const inputTokens = (n + 1) * input + ((n * (n + 1)) / 2) * (call + t.resultTokens);
  return costUsd(card.price, { inputTokens, outputTokens: n * call + output });
}

/**
 * Cost band of one protocol step. Per call: low and high input (`input.tokens`, else the
 * estimate's, times the input-estimate error), low and high output (calibration spread when known, else
 * `HEURISTIC_SPREAD` around the expected output) clipped to the output cap, and tool
 * rounds when the node lists tools; low × fewest calls, high × most calls. The expected
 * per-call cost (`likelyUsd`, default the estimate's) is kept inside; without full history
 * the high is capped at `HEURISTIC_MAX_RATIO` × expected.
 */
export function stepBand(
  card: ModelCard | undefined,
  estimate: CostEstimate,
  calls: { min: number; max: number },
  spread: OutputSpread | undefined,
  input?: StepInput,
  likelyUsd = estimate.expectedCostUsd,
): StepBand {
  const out = outputRange(card, estimate, spread);
  const flat = input?.tokens ?? { low: estimate.inputTokens, high: estimate.inputTokens };
  const ratio = spread?.inputRatio ?? HEURISTIC_INPUT_RATIO;
  const inTok = { low: flat.low * ratio.low, high: flat.high * ratio.high };
  const rounds = input?.tools ? (spread?.toolRounds ?? HEURISTIC_TOOL_ROUNDS) : undefined;
  const per = (i: number, o: number, n: number): number =>
    card ? r6(withRounds(card, i, o, n, rounds ?? NO_ROUNDS)) : estimate.expectedCostUsd;
  const learned = spread !== undefined && (input?.calibrated ?? true);
  const heuristicRounds = rounds !== undefined && rounds.samples === 0;
  const basis: BandBasis = !spread
    ? 'heuristic'
    : learned && !heuristicRounds
      ? 'calibrated'
      : 'mixed';
  const perCallLowUsd = per(inTok.low, out.low, rounds?.low ?? 0);
  const computedHigh = Math.max(perCallLowUsd, per(inTok.high, out.high, rounds?.high ?? 0));
  const perCallUsd = r6(Math.min(computedHigh, Math.max(perCallLowUsd, likelyUsd)));
  const perCallHighUsd =
    basis === 'calibrated'
      ? computedHigh
      : r6(Math.min(computedHigh, HEURISTIC_MAX_RATIO * perCallUsd));
  return {
    perCallLowUsd,
    perCallHighUsd,
    lowUsd: r6(perCallLowUsd * calls.min),
    highUsd: r6(perCallHighUsd * calls.max),
    basis,
    samples: spread?.samples ?? 0,
    outputTokens: out,
    perCallUsd,
  };
}

/** Output tokens of one call: the spread, else the cold-start factors around the expected. */
function outputRange(
  card: ModelCard | undefined,
  estimate: CostEstimate,
  spread: OutputSpread | undefined,
): TokenRange {
  const clip = (t: number): number => Math.min(estimate.maxOutputTokens, Math.max(0, t));
  if (spread) return { low: clip(spread.low), high: clip(spread.high) };
  const inputUsd = card
    ? costUsd(card.price, { inputTokens: estimate.inputTokens, outputTokens: 0 })
    : 0;
  const perTok = card ? card.price.outputPerMTok / 1e6 : 0;
  const expected = perTok > 0 ? Math.max(0, (estimate.expectedCostUsd - inputUsd) / perTok) : 0;
  return {
    low: clip(expected * HEURISTIC_SPREAD.low),
    high: clip(expected * HEURISTIC_SPREAD.high),
  };
}

/** Sum of bands; the basis is `mixed` when the parts disagree. An empty sum is heuristic. */
export function sumBands(bands: readonly CostBand[]): CostBand {
  const bases = new Set(bands.map((b) => b.basis));
  const basis: BandBasis =
    bases.size === 1 ? (bands[0] as CostBand).basis : bases.size === 0 ? 'heuristic' : 'mixed';
  return {
    lowUsd: r6(bands.reduce((a, b) => a + b.lowUsd, 0)),
    highUsd: r6(bands.reduce((a, b) => a + b.highUsd, 0)),
    basis,
  };
}
