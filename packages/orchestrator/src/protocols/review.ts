import { refToString, type ModelRef, type RoutingDecision, type Verdict } from '@kernelpai/core';
import type { Dispute } from '../dispute.js';
import { accepted, parseVerdict } from '../parse.js';
import { criticPrompt, criticRetryPrompt } from '../prompts.js';
import { decisionAfter, onlyDecision } from '../routing.js';
import type { StepRunner } from '../step.js';
import { testEvidenceText } from '../test-gate.js';
import type { NodeRun, StepFailed, StepOk } from '../types.js';

/** One critic's verdict and the model that gave it. */
export interface Review {
  ref: ModelRef;
  verdict: Verdict;
}

type Reviewed = ({ ok: true } & Review) | StepFailed;

/** Most critics a node may ask per round (each from a new provider). */
export const MAX_CRITICS = 3;

/** Critics wanted per round for a node: its own count (1 to 3), default 1. */
export function criticsOf(n: unknown): number {
  return typeof n === 'number' && Number.isInteger(n) ? Math.min(MAX_CRITICS, Math.max(1, n)) : 1;
}

/**
 * One review round: `wanted` critics, each routed away from the authors and from the
 * critics before it (principle 2). The first critic follows the node's diversity rule; the
 * extra ones are `strict` and, when no new provider is left, the round goes on with fewer
 * (journaled). Any failed critic fails the round.
 */
export async function reviewRound(
  s: StepRunner,
  run: NodeRun,
  work: string,
  authors: string[],
  wanted: number,
): Promise<{ ok: true; reviews: Review[] } | StepFailed> {
  const reviews: Review[] = [];
  for (let i = 0; i < wanted; i++) {
    const exclude = [...authors, ...reviews.map((r) => r.ref.provider)];
    const r = await critique(s, run, work, exclude, i === 0 ? undefined : 'strict');
    if (!r.ok && r.diversity && i > 0) {
      s.intervention(run.node.id, {
        action: 'diversity reduced',
        role: 'critic',
        reason: `only ${i} distinct critic provider(s) available for ${wanted} critics`,
      });
      break;
    }
    if (!r.ok) return r;
    reviews.push({ ref: r.ref, verdict: r.verdict });
  }
  return { ok: true, reviews };
}

/** The rejecting verdicts of a round merged into one, for the revision prompt. */
export function mergedVerdict(reviews: readonly Review[]): Verdict {
  const rejecting = reviews.filter((r) => !accepted(r.verdict));
  return {
    approve: false,
    issues: rejecting.flatMap((r) => r.verdict.issues),
    summary: rejecting.map((r) => r.verdict.summary).join(' / '),
  };
}

const says = (v: Verdict): string =>
  [
    `${v.approve ? 'approve' : 'reject'}: ${v.summary}`,
    ...v.issues.map((i) => `[${i.severity}] ${i.text}`),
  ].join('\n');

/**
 * The critics still split after the last revision (R-405): one option, accepting the work
 * as the approving critics do; the human's rejection sides with the others.
 */
export function criticDispute(reviews: readonly Review[], work: string): Dispute {
  const yes = reviews.filter((r) => accepted(r.verdict));
  const no = reviews.length - yes.length;
  return {
    kind: 'critics',
    reason: `critics disagree: ${yes.length} approve, ${no} reject`,
    options: [
      {
        id: 'accept',
        label: `accept the work as approved by ${yes.map((r) => refToString(r.ref)).join(', ')}`,
        text: work,
        backers: yes.map((r) => r.ref),
      },
    ],
    positions: reviews.map((r) => ({
      ref: r.ref,
      role: 'critic' as const,
      says: says(r.verdict),
      ...(accepted(r.verdict) ? { option: 'accept' } : {}),
    })),
  };
}

type Once =
  | { kind: 'verdict'; review: Review }
  | { kind: 'malformed'; step: StepOk; error: string }
  | { kind: 'failed'; step: StepFailed };

/**
 * One critic, routed away from every author provider. Invalid verdict JSON gets one retry
 * on the same model; still invalid is `malformed` and the next routed candidate is asked,
 * as a fallback would be. No candidate left → the review fails.
 */
async function critique(
  s: StepRunner,
  run: NodeRun,
  work: string,
  exclude: string[],
  diversity?: 'strict',
): Promise<Reviewed> {
  const prompt = criticPrompt(run.node, run.context, work, testEvidenceText(run));
  let decision: RoutingDecision | undefined;
  for (;;) {
    const once = await criticOnce(s, run, { prompt, exclude, decision, diversity });
    if (once.kind === 'verdict') return { ok: true, ...once.review };
    if (once.kind === 'failed') return once.step;
    const from = once.step.ref;
    journalMalformed(s, run, from, once.error);
    decision = decisionAfter(once.step.decision, from);
    if (!decision) {
      return {
        ok: false,
        error: `critic output malformed: no valid verdict JSON (${once.error})`,
        cancelled: false,
        costUsd: 0,
      };
    }
    journalCriticFallback(s, run, from, decision);
  }
}

async function criticOnce(
  s: StepRunner,
  run: NodeRun,
  a: {
    prompt: string;
    exclude: string[];
    decision: RoutingDecision | undefined;
    diversity: 'strict' | undefined;
  },
): Promise<Once> {
  const base = { role: 'critic' as const, type: 'critique' as const, deferRecord: true };
  const first = await s.run(run, {
    ...base,
    prompt: a.prompt,
    exclude: a.exclude,
    ...(a.diversity ? { diversity: a.diversity } : {}),
    ...(a.decision ? { decision: a.decision } : {}),
  });
  if (!first.ok) return { kind: 'failed', step: first };
  const parsed = parseVerdict(first.text);
  if (parsed.ok) return recorded(s, run, first, parsed.value);
  s.record(run, first.contribution);
  const retry = await s.run(run, {
    ...base,
    prompt: criticRetryPrompt(a.prompt, parsed.error),
    decision: onlyDecision(run.node.id, first.served),
  });
  if (!retry.ok) return { kind: 'failed', step: retry };
  const again = parseVerdict(retry.text);
  if (again.ok) return recorded(s, run, retry, again.value);
  s.record(run, retry.contribution);
  return { kind: 'malformed', step: first, error: again.error };
}

function recorded(s: StepRunner, run: NodeRun, step: StepOk, verdict: Verdict): Once {
  s.record(run, { ...step.contribution, verdict });
  return { kind: 'verdict', review: { ref: step.ref, verdict } };
}

function journalMalformed(
  s: StepRunner,
  run: NodeRun,
  ref: { provider: string; model: string },
  error: string,
): void {
  s.o.journal.append({
    sessionId: s.o.sessionId,
    type: 'error',
    nodeId: run.node.id,
    provider: ref.provider,
    model: ref.model,
    payload: {
      role: 'critic',
      kind: 'malformed',
      message: `invalid verdict after retry: ${error}`,
    },
  });
}

function journalCriticFallback(
  s: StepRunner,
  run: NodeRun,
  from: { provider: string; model: string },
  next: RoutingDecision,
): void {
  s.o.journal.append({
    sessionId: s.o.sessionId,
    type: 'routing',
    nodeId: run.node.id,
    provider: next.chosen.ref.provider,
    model: next.chosen.ref.model,
    payload: {
      role: 'critic',
      reason: `fallback to ${refToString(next.chosen.ref)} after ${refToString(from)}: malformed`,
      fallbackFrom: refToString(from),
      kind: 'malformed',
    },
  });
}
