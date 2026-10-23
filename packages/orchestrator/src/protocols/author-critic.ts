import type { ProtocolResult } from '@kernelpai/core';
import { disputed } from '../dispute.js';
import { accepted } from '../parse.js';
import { authorPrompt, revisionPrompt } from '../prompts.js';
import type { StepRunner } from '../step.js';
import { DEFAULT_MAX_REVISIONS, type NodeRun, type PlannedNode, type StepOk } from '../types.js';
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
  const author = await s.run(run, { role: 'author', prompt: authorPrompt(node, context) });
  if (!author.ok) return failure(run, 'author_critic', author);
  let current: StepOk = author;
  const providers = [author.ref.provider];
  const max = s.o.maxRevisions ?? DEFAULT_MAX_REVISIONS;
  const wanted = criticsOf((node as PlannedNode).critics);
  for (let round = 0; ; round++) {
    const review = await reviewRound(s, run, current.text, providers, wanted);
    if (!review.ok) return failure(run, 'author_critic', review, current.text);
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
    const revision = await s.run(run, {
      role: 'revision',
      prompt: revisionPrompt(node, context, current.text, mergedVerdict(review.reviews)),
      prefer: current.ref,
    });
    if (!revision.ok) return failure(run, 'author_critic', revision, current.text);
    current = revision;
    providers.push(revision.ref.provider);
  }
}
