/**
 * S10 R3 safeguards (D-029), pure: envelope expiry (14 days by default), the spend-rate cap
 * across the portfolio, and progress-gated burn (a pause when a quarter of a phase cap is
 * spent with no new verified result). The daemon applies them; nothing here starts a run.
 */
import { committedUsd } from './ledger.js';
import type { Assurance, ProgramState, RunRecord } from './schemas.js';

export const DEFAULT_EXPIRY_DAYS = 14;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const EPS = 1e-9;

/**
 * When the delegation envelope stops covering unattended work: its own `expires`, else
 * 14 days after the Sponsor's approval (S10 R3: expiry is mandatory when unattended).
 */
export function effectiveExpiry(
  s: Pick<ProgramState, 'charter' | 'approval'>,
  days = DEFAULT_EXPIRY_DAYS,
): Date | undefined {
  const own = s.charter.envelope.expires;
  if (own) return new Date(own);
  if (!s.approval) return undefined;
  return new Date(Date.parse(s.approval.at) + days * DAY_MS);
}

export function envelopeExpired(
  s: Pick<ProgramState, 'charter' | 'approval'>,
  now: Date,
  days = DEFAULT_EXPIRY_DAYS,
): boolean {
  const at = effectiveExpiry(s, days);
  return at !== undefined && now.getTime() >= at.getTime();
}

/** An ISO instant `days` after `now`: the default expiry of a drafted envelope. */
export function expiryFrom(now: Date, days = DEFAULT_EXPIRY_DAYS): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

/**
 * What runs weigh in the last hour: a live run its band top (D-021: what it may still
 * spend), a run settled within the hour what it cost. Every program of the portfolio.
 */
export function spendLastHour(runs: readonly RunRecord[], now: Date): number {
  const from = now.getTime() - HOUR_MS;
  let usd = 0;
  for (const r of runs) {
    if (r.status === 'running') usd += committedUsd(r);
    else if (Date.parse(r.settledAt ?? r.startedAt) >= from) usd += r.costUsd;
  }
  return usd;
}

/** Why one more run of this band top would pass the $/hour cap, or undefined. */
export function velocityBlocker(
  runs: readonly RunRecord[],
  nextCapUsd: number,
  usdPerHour: number | undefined,
  now: Date,
): string | undefined {
  if (usdPerHour === undefined) return undefined;
  const used = spendLastHour(runs, now);
  if (used + nextCapUsd <= usdPerHour + EPS) return undefined;
  return `spend rate: $${used.toFixed(2)} in the last hour + $${nextCapUsd.toFixed(2)} > $${usdPerHour.toFixed(2)}/h`;
}

const RANK: Record<Assurance, number> = { V0: 0, V1: 1, V2: 2, V3: 3 };

/** True when `label` is at least `min`. A missing label is V0. */
export function atLeast(label: Assurance | undefined, min: Assurance): boolean {
  return RANK[label ?? 'V0'] >= RANK[min];
}

export const PROGRESS_STEP = 0.25;

export interface ProgressCheck {
  phaseId: string;
  /** Quarters of the phase cap spent so far (0–4). */
  checkpoint: number;
  /** Finished runs of the phase with assurance ≥ V1. */
  verified: number;
  spentUsd: number;
  capUsd: number;
}

/** Spend and verified results of the current phase, by quarter of its cap. */
export function progressOf(s: ProgramState): ProgressCheck | undefined {
  const phase = s.charter.phases[s.phaseIndex];
  if (!phase) return undefined;
  const runs = s.runs.filter((r) => r.phaseId === phase.id);
  const spentUsd = runs.reduce((a, r) => a + r.costUsd, 0);
  const step = phase.capUsd * PROGRESS_STEP;
  const checkpoint = step > 0 ? Math.min(4, Math.floor(spentUsd / step + EPS)) : 0;
  const verified = runs.filter((r) => r.status === 'finished' && atLeast(r.assurance, 'V1'));
  return {
    phaseId: phase.id,
    checkpoint,
    verified: verified.length,
    spentUsd,
    capUsd: phase.capUsd,
  };
}

/**
 * S10 R3 progress gating: after each quarter of the phase cap, at least one more verified
 * result (≥ V1) or the program pauses. `acked` is the last checkpoint the Sponsor let pass.
 */
export function noProgress(s: ProgramState, acked = 0): ProgressCheck | undefined {
  if (s.status !== 'running') return undefined;
  const p = progressOf(s);
  if (!p || p.checkpoint < 1 || p.checkpoint <= acked) return undefined;
  return p.verified >= p.checkpoint ? undefined : p;
}
