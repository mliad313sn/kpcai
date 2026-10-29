/**
 * Guardrails G1, G2 and G4 of the north star (docs/consulting/METRICS-NORTH-STAR.md §2,
 * formulas in docs/metrics/NORTH-STAR.md), from the journal only:
 *
 * - G1 cost per DVO and cost-band honesty;
 * - G2 attention load and rubber-stamp rate, from the answered questions (J2): kernel
 *   confirmations (`confirmation answered`) and the Sponsor's answers (`sponsor answer`);
 * - G4 escape rate: accepted deliverables rolled back or reverted within 7 days, by label.
 */
import type { JournalEvent } from '@kernelpai/journal';
import type { Assurance } from '@kernelpai/program';
import type { Deliverable } from './deliverables.js';
import type { RunRecord } from './runs.js';

/** An approval this fast after the evidence was shown is a stamp, not a decision. */
export const RUBBER_STAMP_MS = 3_000;

export const ASK_ACTIONS = {
  interactive: 'confirmation answered',
  sponsor: 'sponsor answer',
  expired: 'question expired',
} as const;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const action = (e: JournalEvent): string | undefined =>
  e.type === 'intervention' ? str(e.payload.action) : undefined;
export const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;
export const r6 = (x: number): number => Math.round(x * 1e6) / 1e6 || 0;
export const ratio = (a: number, b: number, round = r4): number | null =>
  b > 0 ? round(a / b) : null;

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export interface CostGuardrail {
  spentUsd: number;
  outcomes: number;
  /** spentUsd ÷ (DVO + DVO-doc); null without an outcome. */
  costPerDvoUsd: number | null;
  band: { runs: number; inBand: number; rate: number | null };
  /** Median over planned runs of band top ÷ likely cost (R-402: ≤ 3 is honest). */
  capToLikelyMedian: number | null;
}

/** G1: everything spent in the window per durable verified outcome, and band honesty. */
export function costGuardrail(
  spentUsd: number,
  outcomes: number,
  band: CostGuardrail['band'],
  runs: readonly RunRecord[],
): CostGuardrail {
  const ratios: number[] = [];
  for (const r of runs) {
    const est = r.plan?.payload.estimate as { capUsd?: unknown; expectedUsd?: unknown } | undefined;
    const cap = Number(est?.capUsd);
    const likely = Number(est?.expectedUsd);
    if (Number.isFinite(cap) && Number.isFinite(likely) && likely > 0 && cap > 0)
      ratios.push(cap / likely);
  }
  const m = median(ratios);
  return {
    spentUsd,
    outcomes,
    costPerDvoUsd: ratio(spentUsd, outcomes, r6),
    band,
    capToLikelyMedian: m === null ? null : r4(m),
  };
}

interface Answer {
  source: 'interactive' | 'sponsor';
  yes: boolean;
  consequential: boolean;
  askedMs: number;
  answeredMs: number;
  /** When the evidence was shown or opened; undefined: never. */
  viewedMs: number | undefined;
}

export interface AttentionGuardrail {
  /** Questions answered or left to expire in the window. */
  asks: number;
  bySource: { interactive: number; sponsor: number; expired: number };
  asksPerDvo: number | null;
  /** Median time from ask to answer, in ms. */
  medianAskAgeMs: number | null;
  /** Consequential yes answers; stamped: evidence never opened, or yes < 3 s after it. */
  rubberStamp: { consequential: number; stamped: number; rate: number | null };
}

function answerOf(e: JournalEvent): Answer | undefined {
  const a = action(e);
  const p = e.payload;
  const askedMs = Date.parse(str(p.askedAt) ?? '');
  const answeredMs = Date.parse(str(p.answeredAt) ?? '');
  if (!Number.isFinite(askedMs) || !Number.isFinite(answeredMs)) return undefined;
  if (a === ASK_ACTIONS.interactive) {
    const shown = p.viewed === 'diff' || p.viewed === 'evidence';
    return {
      source: 'interactive',
      yes: p.answer === 'yes',
      consequential: p.consequential === true,
      askedMs,
      answeredMs,
      viewedMs: shown ? askedMs : undefined,
    };
  }
  if (a !== ASK_ACTIONS.sponsor) return undefined;
  const viewedAt = Date.parse(str(p.viewedAt) ?? '');
  return {
    source: 'sponsor',
    yes: p.answer === 'yes',
    consequential: p.class === 'consequential',
    askedMs,
    answeredMs,
    viewedMs: p.viewed === true ? (Number.isFinite(viewedAt) ? viewedAt : askedMs) : undefined,
  };
}

/** G2 over the questions journaled at or after `from`. */
export function attentionGuardrail(
  events: readonly JournalEvent[],
  from: number | undefined,
  outcomes: number,
): AttentionGuardrail {
  const inWindow = events.filter((e) => from === undefined || Date.parse(e.ts) >= from);
  const answers = inWindow.map(answerOf).filter((a): a is Answer => a !== undefined);
  const expired = inWindow.filter((e) => action(e) === ASK_ACTIONS.expired).length;
  const interactive = answers.filter((a) => a.source === 'interactive').length;
  const asks = answers.length + expired;
  const approvals = answers.filter((a) => a.yes && a.consequential);
  const stamped = approvals.filter(
    (a) => a.viewedMs === undefined || a.answeredMs - a.viewedMs < RUBBER_STAMP_MS,
  ).length;
  const age = median(answers.map((a) => Math.max(0, a.answeredMs - a.askedMs)));
  return {
    asks,
    bySource: { interactive, sponsor: answers.length - interactive, expired },
    asksPerDvo: ratio(asks, outcomes),
    medianAskAgeMs: age === null ? null : Math.round(age),
    rubberStamp: {
      consequential: approvals.length,
      stamped,
      rate: ratio(stamped, approvals.length),
    },
  };
}

export interface EscapeRow {
  accepted: number;
  escaped: number;
  rate: number | null;
}

export interface EscapeGuardrail extends EscapeRow {
  rolledBack: number;
  reverted: number;
  byAssurance: Record<Assurance, EscapeRow>;
}

/** G4: accepted deliverables that landed in the window and were undone within 7 days. */
export function escapeGuardrail(list: readonly Deliverable[]): EscapeGuardrail {
  const row = (xs: readonly Deliverable[]): EscapeRow => {
    const escaped = xs.filter((d) => d.undone).length;
    return { accepted: xs.length, escaped, rate: ratio(escaped, xs.length) };
  };
  const by = (a: Assurance) => row(list.filter((d) => d.assurance === a));
  return {
    ...row(list),
    rolledBack: list.filter((d) => d.undone?.kind === 'rollback').length,
    reverted: list.filter((d) => d.undone?.kind === 'revert').length,
    byAssurance: { V0: by('V0'), V1: by('V1'), V2: by('V2'), V3: by('V3') },
  };
}
