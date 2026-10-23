import type { ProtocolName, ProtocolResult } from '@kernelpai/core';
import { authorPrompt } from '../prompts.js';
import type { StepRunner } from '../step.js';
import type { NodeRun } from '../types.js';
import { authorCritic } from './author-critic.js';
import { debate } from './debate.js';
import { failure, finish } from './result.js';
import { vote } from './vote.js';

/**
 * Solo: one routed model answers (its prompt uses the author role line). A `critique` node
 * reviewing earlier nodes is routed away from their providers (principle 2: fails unless
 * `allowSameProvider`, then the waiver is journaled).
 */
export async function solo(s: StepRunner, run: NodeRun): Promise<ProtocolResult> {
  const review = run.node.type === 'critique' && (run.upstream?.length ?? 0) > 0;
  const r = await s.run(run, {
    role: 'solo',
    prompt: authorPrompt(run.node, run.context),
    ...(review ? { exclude: run.upstream } : {}),
  });
  return r.ok ? finish(run, 'solo', r.text) : failure(run, 'solo', r);
}

export type Protocol = (s: StepRunner, run: NodeRun) => Promise<ProtocolResult>;

export const PROTOCOLS: Record<ProtocolName, Protocol> = {
  solo,
  author_critic: authorCritic,
  debate,
  vote,
};
