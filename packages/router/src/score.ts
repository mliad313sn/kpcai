import type { ModelCard, RoutingWeights, ScoreParts, TaskType } from '@kernelpai/core';

/** Neutral prior when a card says nothing about a task type. */
export const NEUTRAL_COMPETENCE = 0.5;
/** Shift applied by a declared strength (+) or weakness (−) when no prior is set. */
export const STRENGTH_SHIFT = 0.25;
/** Samples at which measured competence counts as much as the static prior. */
export const MEASURED_HALF_WEIGHT_SAMPLES = 10;
/** Penalties are clipped to [0, PENALTY_CAP]. */
export const PENALTY_CAP = 1;
/** Latency penalty for a card without `latencyMsTypical`: neutral, not free. */
export const UNKNOWN_LATENCY_PENALTY = 0.5;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** `card.competence[type]` if set, else 0.5 shifted by declared strengths/weaknesses. */
export function staticCompetence(card: ModelCard, type: TaskType): number {
  const prior = card.competence?.[type];
  if (prior !== undefined) return clamp(prior, 0, 1);
  let c = NEUTRAL_COMPETENCE;
  if (card.strengths?.includes(type)) c += STRENGTH_SHIFT;
  if (card.weaknesses?.includes(type)) c -= STRENGTH_SHIFT;
  return clamp(c, 0, 1);
}

/**
 * Measured competence shrunk toward the static prior by sample count:
 * confidence = n / (n + 10). With no data the measured term equals the prior,
 * so w1 + w2 together weigh the static sheet until evidence accumulates.
 */
export function blendMeasured(
  prior: number,
  measured: { score: number; samples: number } | undefined,
): number {
  if (!measured || measured.samples <= 0) return prior;
  const confidence = measured.samples / (measured.samples + MEASURED_HALF_WEIGHT_SAMPLES);
  return confidence * clamp(measured.score, 0, 1) + (1 - confidence) * prior;
}

/** expected cost / reference (node budget, else the absolute cost reference), capped. A zero reference gives any paid call the cap. */
export function costPenalty(expectedCostUsd: number, budgetUsd: number): number {
  if (!(budgetUsd > 0)) return expectedCostUsd > 0 ? PENALTY_CAP : 0;
  return clamp(expectedCostUsd / budgetUsd, 0, PENALTY_CAP);
}

/** typical latency / reference (node cap, else the absolute latency reference), capped; unknown latency is neutral. */
export function latencyPenalty(latencyMs: number | undefined, maxLatencyMs: number): number {
  if (latencyMs === undefined) return UNKNOWN_LATENCY_PENALTY;
  if (!(maxLatencyMs > 0)) return 0;
  return clamp(latencyMs / maxLatencyMs, 0, PENALTY_CAP);
}

/** A measured-competence sample as returned by `MeasuredCompetence.get`. */
export type MeasuredSample = { score: number; samples: number } | undefined;

export interface ScoreInputs {
  card: ModelCard;
  type: TaskType;
  expectedCostUsd: number;
  budgetUsd: number;
  maxLatencyMs: number;
  measured?: MeasuredSample;
}

/** The four normalised factors of spec §5.3 for one candidate. */
export function scoreParts(i: ScoreInputs): ScoreParts {
  const m = i.measured;
  return {
    staticCompetence: staticCompetence(i.card, i.type),
    measuredCompetence: m && m.samples > 0 ? clamp(m.score, 0, 1) : null,
    costPenalty: costPenalty(i.expectedCostUsd, i.budgetUsd),
    latencyPenalty: latencyPenalty(i.card.latencyMsTypical, i.maxLatencyMs),
  };
}

/** Weighted contribution of each factor to the score. */
export interface Contributions {
  competence: number;
  measured: number;
  cost: number;
  latency: number;
}

/** Spec §5.3 terms: w1·static, w2·measured (blended), −w3·cost, −w4·latency. */
export function contributions(
  parts: ScoreParts,
  w: RoutingWeights,
  measured?: MeasuredSample,
): Contributions {
  return {
    competence: w.competenceStatic * parts.staticCompetence,
    measured: w.competenceMeasured * blendMeasured(parts.staticCompetence, measured),
    cost: -w.cost * parts.costPenalty,
    latency: -w.latency * parts.latencyPenalty,
  };
}

/** Sum of the contributions: the candidate's score. */
export function sumContributions(c: Contributions): number {
  return c.competence + c.measured + c.cost + c.latency;
}
