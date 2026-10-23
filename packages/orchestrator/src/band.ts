import {
  costUsd,
  type CostEstimate,
  type ModelCard,
  type ModelRef,
  type TaskType,
} from '@kernelpai/core';
import type { Journal, JournalEvent } from '@kernelpai/journal';

/** Spread of a model's output length on a task type, learned from the journal (tokens). */
export interface OutputSpread {
  low: number;
  median: number;
  high: number;
  samples: number;
}

export type SpreadFn = (ref: ModelRef, taskType: TaskType) => OutputSpread | undefined;

export type BandBasis = 'calibrated' | 'heuristic' | 'mixed';

/** A low–high cost range (R-302). */
export interface CostBand {
  lowUsd: number;
  highUsd: number;
  /** `calibrated`: every step priced from history; `heuristic`: none; `mixed`: some. */
  basis: BandBasis;
}

export interface StepBand extends CostBand {
  perCallLowUsd: number;
  perCallHighUsd: number;
  /** History samples behind the spread (0 when heuristic). */
  samples: number;
}

/**
 * Output multipliers around the expected output when there is no history: half to twice
 * the typical answer (itself a quarter of the output cap, see the core estimator).
 */
export const HEURISTIC_SPREAD = { low: 0.5, high: 2 } as const;

export interface OutputSpreadOptions {
  /** Most recent successful responses kept per (provider, model, task type). Default 20. */
  window?: number;
  /** Fewer samples than this → no spread (heuristic band). Default 3. */
  minSamples?: number;
  /** Maximum journal events read (most recent). Default 100,000. */
  limit?: number;
  /** Quantiles taken as the low and high ends. Default 0.1 and 0.9. */
  lowQuantile?: number;
  highQuantile?: number;
}

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Linear-interpolated quantile of a non-empty list. */
export function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = Math.min(1, Math.max(0, q)) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
}

const NOT_ANSWERED = new Set(['cancelled', 'refusal']);
const key = (p: string, m: string, t: string): string => `${p}\u0000${m}\u0000${t}`;

/**
 * Output spread per model and task type from the journal (same samples as the executor's
 * `outputCalibration`: reported output tokens of successful responses, task type from the
 * matching `call`). The journal is read once, now.
 */
export function outputSpread(journal: Journal, options: OutputSpreadOptions = {}): SpreadFn {
  const window = options.window ?? 20;
  const minSamples = options.minSamples ?? 3;
  const samples = collect(journal.events({ limit: options.limit ?? 100_000 }));
  const spreads = new Map<string, OutputSpread>();
  for (const [k, xs] of samples) {
    const recent = xs.slice(-window);
    if (recent.length < Math.max(1, minSamples)) continue;
    spreads.set(k, {
      low: quantile(recent, options.lowQuantile ?? 0.1),
      median: quantile(recent, 0.5),
      high: quantile(recent, options.highQuantile ?? 0.9),
      samples: recent.length,
    });
  }
  return (ref, taskType) => spreads.get(key(ref.provider, ref.model, taskType));
}

function collect(events: readonly JournalEvent[]): Map<string, number[]> {
  const taskTypeOf = new Map<string, string>();
  const samples = new Map<string, number[]>();
  for (const e of events) {
    const requestId = e.payload.requestId;
    if (typeof requestId !== 'string') continue;
    if (e.type === 'call' && typeof e.payload.taskType === 'string') {
      taskTypeOf.set(requestId, e.payload.taskType);
      continue;
    }
    if (e.type !== 'response' || !e.provider || !e.model) continue;
    const taskType = taskTypeOf.get(requestId);
    const out = e.payload.outputTokens;
    const stop = e.payload.stopReason;
    if (taskType === undefined || e.payload.usageBasis !== 'reported') continue;
    if (typeof out !== 'number' || !(out > 0)) continue;
    if (typeof stop === 'string' && NOT_ANSWERED.has(stop)) continue;
    const k = key(e.provider, e.model, taskType);
    samples.set(k, [...(samples.get(k) ?? []), out]);
  }
  return samples;
}

/**
 * Cost band of one protocol step: per call, the input cost plus the low and high output
 * (calibration spread when known, else `HEURISTIC_SPREAD` around the expected output),
 * clipped to the output cap; low × fewest calls, high × most calls.
 */
export function stepBand(
  card: ModelCard | undefined,
  estimate: CostEstimate,
  calls: { min: number; max: number },
  spread: OutputSpread | undefined,
): StepBand {
  const inputUsd = card
    ? costUsd(card.price, { inputTokens: estimate.inputTokens, outputTokens: 0 })
    : 0;
  const perTok = card ? card.price.outputPerMTok / 1e6 : 0;
  const expectedOut = perTok > 0 ? Math.max(0, (estimate.expectedCostUsd - inputUsd) / perTok) : 0;
  const clip = (t: number): number => Math.min(estimate.maxOutputTokens, Math.max(0, t));
  const [lo, hi] = spread
    ? [spread.low, spread.high]
    : [expectedOut * HEURISTIC_SPREAD.low, expectedOut * HEURISTIC_SPREAD.high];
  const perCallLowUsd = card ? r6(inputUsd + clip(lo) * perTok) : estimate.expectedCostUsd;
  const perCallHighUsd = card ? r6(inputUsd + clip(hi) * perTok) : estimate.expectedCostUsd;
  return {
    perCallLowUsd,
    perCallHighUsd,
    lowUsd: r6(perCallLowUsd * calls.min),
    highUsd: r6(perCallHighUsd * calls.max),
    basis: spread ? 'calibrated' : 'heuristic',
    samples: spread?.samples ?? 0,
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
