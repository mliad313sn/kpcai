import {
  refToString,
  type ProtocolResult,
  type RoutingDecision,
  type Verdict,
} from '@kernelpai/core';
import { accepted, parseVerdict } from '../parse.js';
import { authorPrompt, criticPrompt, criticRetryPrompt, revisionPrompt } from '../prompts.js';
import { decisionAfter, onlyDecision } from '../routing.js';
import type { StepRunner } from '../step.js';
import { DEFAULT_MAX_REVISIONS, type NodeRun, type StepFailed, type StepOk } from '../types.js';
import { failure, finish } from './result.js';

type Review = { ok: true; verdict: Verdict } | StepFailed;

export { accepted };

/**
 * Author + critic (spec §3.1): the author drafts; a critic from another provider
 * (principle 2) returns a structured verdict; on rejection the author revises, at most
 * `maxRevisions` times. The final approval is recorded in `approved`.
 */
export async function authorCritic(s: StepRunner, run: NodeRun): Promise<ProtocolResult> {
  const { node, context } = run;
  const author = await s.run(run, { role: 'author', prompt: authorPrompt(node, context) });
  if (!author.ok) return failure(run, 'author_critic', author);
  let current: StepOk = author;
  const providers = [author.ref.provider];
  const max = s.o.maxRevisions ?? DEFAULT_MAX_REVISIONS;
  for (let round = 0; ; round++) {
    const review = await critique(s, run, current.text, providers);
    if (!review.ok) return failure(run, 'author_critic', review, current.text);
    if (accepted(review.verdict)) return finish(run, 'author_critic', current.text, true);
    if (round >= max) {
      s.intervention(node.id, {
        action: 'not approved',
        role: 'critic',
        reason: `critic did not approve after ${max} revision(s)`,
      });
      return finish(run, 'author_critic', current.text, false);
    }
    const revision = await s.run(run, {
      role: 'revision',
      prompt: revisionPrompt(node, context, current.text, review.verdict),
      prefer: current.ref,
    });
    if (!revision.ok) return failure(run, 'author_critic', revision, current.text);
    current = revision;
    providers.push(revision.ref.provider);
  }
}

type Once =
  | { kind: 'verdict'; verdict: Verdict }
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
): Promise<Review> {
  const prompt = criticPrompt(run.node, run.context, work);
  let decision: RoutingDecision | undefined;
  for (;;) {
    const once = await criticOnce(s, run, { prompt, exclude, decision });
    if (once.kind === 'verdict') return { ok: true, verdict: once.verdict };
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
  a: { prompt: string; exclude: string[]; decision: RoutingDecision | undefined },
): Promise<Once> {
  const base = { role: 'critic' as const, type: 'critique' as const, deferRecord: true };
  const first = await s.run(run, {
    ...base,
    prompt: a.prompt,
    exclude: a.exclude,
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
  return { kind: 'verdict', verdict };
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
