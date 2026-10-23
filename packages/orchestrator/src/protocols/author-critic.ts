import type { ProtocolResult, Verdict } from '@kernelpai/core';
import { authorProviders, authorStep } from '../agent-author.js';
import { disputed } from '../dispute.js';
import { accepted } from '../parse.js';
import { agentPrompt, agentRevisionPrompt, authorPrompt, revisionPrompt } from '../prompts.js';
import type { StepRunner } from '../step.js';
import { gateOnTests } from '../test-gate.js';
import {
  DEFAULT_MAX_REVISIONS,
  type NodeRun,
  type PlannedNode,
  type StepOk,
  type StepSpec,
} from '../types.js';
import { failure, finish } from './result.js';
import { criticDispute, criticsOf, mergedVerdict, reviewRound } from './review.js';

export { accepted };

/**
 * Author + critic (spec §3.1): the author drafts; one critic (or `node.critics`, up to 3,
 * each from another provider, principle 2) returns a structured verdict; when any critic
 * rejects, the author revises against the rejecting verdicts, at most `maxRevisions` times.
 * The final approval (every critic approves) is recorded in `approved`. Critics still split
 * after the last revision make the node disputed (R-405): the human decides.
 */
export async function authorCritic(s: StepRunner, run: NodeRun): Promise<ProtocolResult> {
  const { node, context } = run;
  run.tests = undefined; // R-505: evidence starts empty for each attempt of the node
  // An agent node's author is its agent CLI (R-503); it counts as its provider(s).
  const author = await authorStep(s, run, authorSpec(run), agentPrompt(node, context));
  if (!author.ok) return failure(run, 'author_critic', author);
  let current: StepOk = author;
  const providers = authorProviders(s, author.ref);
  const max = s.o.maxRevisions ?? DEFAULT_MAX_REVISIONS;
  const wanted = criticsOf((node as PlannedNode).critics);
  for (let round = 0; ; round++) {
    const reviewed = await reviewRound(s, run, current.text, providers, wanted);
    if (!reviewed.ok) return failure(run, 'author_critic', reviewed, current.text);
    // R-505: failing tests of this draft turn any approval into a revision request.
    const review = { ...reviewed, reviews: gateOnTests(s, run, reviewed.reviews) };
    const yes = review.reviews.filter((r) => accepted(r.verdict)).length;
    if (yes === review.reviews.length) return finish(run, 'author_critic', current.text, true);
    if (round >= max) {
      if (yes > 0)
        return disputed(run, 'author_critic', criticDispute(review.reviews, current.text));
      s.intervention(node.id, {
        action: 'not approved',
        role: 'critic',
        reason: `critic did not approve after ${max} revision(s)`,
      });
      return finish(run, 'author_critic', current.text, false);
    }
    if (yes > 0) {
      s.intervention(node.id, {
        action: 'critics split',
        reason: `${yes} of ${review.reviews.length} critics approve: revising against the others`,
      });
    }
    // The last test run stays the evidence until a new one replaces it: a revision that
    // does not re-run failing tests cannot be approved (fail closed, R-505).
    const verdict = mergedVerdict(review.reviews);
    const revision = await authorStep(
      s,
      run,
      revisionSpec(run, current, verdict),
      agentRevisionPrompt(node, context, verdict),
    );
    if (!revision.ok) return failure(run, 'author_critic', revision, current.text);
    current = revision;
    providers.push(...authorProviders(s, revision.ref));
  }
}

/** The routed author step (also an agent node's fallback). */
function authorSpec(run: NodeRun): StepSpec {
  return { role: 'author', prompt: authorPrompt(run.node, run.context) };
}

/** The routed revision step, preferring the author's model. */
function revisionSpec(run: NodeRun, current: StepOk, verdict: Verdict): StepSpec {
  const prompt = revisionPrompt(run.node, run.context, current.text, verdict);
  return { role: 'revision', prompt, prefer: current.ref };
}
