/**
 * S10 R8: approval friction in proportion to risk. Trivial questions may be answered in a
 * batch; consequential ones one at a time and only after their evidence was opened. The
 * rubber-stamp rate (metric G2) counts consequential approvals given unseen or in < 3 s.
 */
import type { Escalation } from './schemas.js';

export type ApprovalClass = 'trivial' | 'consequential';

/**
 * Low-risk questions only: an in-worktree write or read tool call the envelope did not
 * pre-answer (`confirm.write`) and an in-envelope spend of a known amount not pre-answered
 * (`confirm.budget`). Everything else is consequential: spend past an accepted cap or of
 * an unknown amount (`confirm.overcap`) or beyond the envelope, a tool that runs code or
 * acts past the worktree (`confirm.exec`), a write outside a worktree (`confirm.outside`)
 * or to a control file (`confirm.control`) (D-035, P5-F2), a pack zone relaxation or
 * workspace opt-in (`confirm.zone`, P5-R3), merges, widening, gates,
 * progress pauses, destructive or physical steps, disputes and unknown rules.
 */
const TRIVIAL_RULES: ReadonlySet<string> = new Set(['confirm.write', 'confirm.budget']);

export function approvalClass(e: Pick<Escalation, 'rule'>): ApprovalClass {
  return TRIVIAL_RULES.has(e.rule) ? 'trivial' : 'consequential';
}

/** One Sponsor answer, as journaled (S10 R6 J2). */
export interface AnswerRecord {
  escalationId: string;
  rule: string;
  answer: 'yes' | 'no';
  askedAt: string;
  answeredAt: string;
  /** The Sponsor opened the evidence before answering. */
  viewed: boolean;
  /** When they opened it: the decision time runs from there (else from the ask). */
  viewedAt?: string;
  batch?: boolean;
}

export const RUBBER_STAMP_MS = 3_000;

export interface RubberStamp {
  /** Stamped ÷ consequential approvals; null when there is none yet. */
  rate: number | null;
  consequential: number;
  stamped: number;
}

/**
 * G2: share of consequential approvals (yes) given without opening the evidence, or less
 * than 3 s after opening it.
 */
export function rubberStampRate(records: readonly AnswerRecord[]): RubberStamp {
  const approvals = records.filter(
    (r) => r.answer === 'yes' && approvalClass({ rule: r.rule }) === 'consequential',
  );
  const stamped = approvals.filter(
    (r) =>
      !r.viewed || Date.parse(r.answeredAt) - Date.parse(r.viewedAt ?? r.askedAt) < RUBBER_STAMP_MS,
  ).length;
  return {
    rate: approvals.length ? stamped / approvals.length : null,
    consequential: approvals.length,
    stamped,
  };
}

/** Why this answer may not be given now, or undefined. */
export function answerBlocker(
  e: Pick<Escalation, 'rule'>,
  o: { viewed: boolean; batch: boolean },
): string | undefined {
  if (approvalClass(e) === 'trivial') return undefined;
  if (o.batch) return 'consequential: answer it on its own, not in a batch';
  if (!o.viewed) return 'consequential: open its evidence first';
  return undefined;
}
