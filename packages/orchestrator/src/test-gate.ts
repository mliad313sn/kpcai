/**
 * Tests as evidence for the critic (R-505, ADR-0032): the last `test.run` of a draft is
 * shown to its critics, and a failing run turns their approval into a revision request
 * (journaled), whatever the critic said.
 */
import type { Verdict } from '@kernelpai/core';
import { evidenceSummary, formatEvidence, testsFailed } from '@kernelpai/tools';
import { accepted } from './parse.js';
import type { Review } from './protocols/review.js';
import type { StepRunner } from './step.js';
import type { NodeRun } from './types.js';

/** The evidence text for the critic prompt, or undefined when no test ran yet. */
export function testEvidenceText(run: NodeRun): string | undefined {
  return run.tests ? formatEvidence(run.tests) : undefined;
}

function withIssue(v: Verdict, text: string): Verdict {
  return {
    approve: false,
    issues: [...v.issues, { severity: 'major', text }],
    summary: v.approve ? `overridden: ${text}` : v.summary,
  };
}

/**
 * The round's reviews after the test gate: with failing evidence every approval becomes a
 * rejection carrying the failure as a major issue (the first rejection carries it when no
 * critic approved), so the author revises against it.
 */
export function gateOnTests(s: StepRunner, run: NodeRun, reviews: readonly Review[]): Review[] {
  const evidence = run.tests;
  if (!testsFailed(evidence) || evidence === undefined) return [...reviews];
  const text = evidenceSummary(evidence);
  const approving = reviews.filter((r) => accepted(r.verdict)).length;
  if (approving > 0) {
    s.intervention(run.node.id, {
      action: 'approval overridden by failing tests',
      role: 'critic',
      reason: text,
      critics: approving,
    });
  }
  let carried = approving > 0;
  return reviews.map((r) => {
    if (accepted(r.verdict)) return { ...r, verdict: withIssue(r.verdict, text) };
    if (carried) return r;
    carried = true;
    return { ...r, verdict: withIssue(r.verdict, text) };
  });
}
