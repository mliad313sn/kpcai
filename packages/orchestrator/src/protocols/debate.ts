import type { ProtocolResult } from '@kernelpai/core';
import { parseJudge } from '../parse.js';
import { debaterPrompt, judgePrompt, rebuttalPrompt } from '../prompts.js';
import type { StepRunner } from '../step.js';
import type { NodeRun } from '../types.js';
import { failure, finish } from './result.js';
import { structured } from './structured.js';

/**
 * Debate (spec §3.1): two debaters from different providers (principle 2, hard), one
 * rebuttal each (run in parallel), then a judge from a third provider when one exists
 * (principle 2: fails unless `allowSameProvider`, then journaled as waived). Output: the judge's answer, else the
 * winning debater's final position.
 */
export async function debate(s: StepRunner, run: NodeRun): Promise<ProtocolResult> {
  const { node, context } = run;
  const d1 = await s.run(run, { role: 'debater', prompt: debaterPrompt(node, context, 1) });
  if (!d1.ok) return failure(run, 'debate', d1);
  const d2 = await s.run(run, {
    role: 'debater',
    prompt: debaterPrompt(node, context, 2),
    exclude: [d1.ref.provider],
  });
  if (!d2.ok) return failure(run, 'debate', d2);
  const [r1, r2] = await Promise.all([
    s.run(run, {
      role: 'debater',
      prompt: rebuttalPrompt(node, context, d1.text, d2.text),
      prefer: d1.ref,
    }),
    s.run(run, {
      role: 'debater',
      prompt: rebuttalPrompt(node, context, d2.text, d1.text),
      prefer: d2.ref,
    }),
  ]);
  if (!r1.ok) return failure(run, 'debate', r1);
  if (!r2.ok) return failure(run, 'debate', r2);
  const judge = await structured(
    s,
    run,
    {
      role: 'judge',
      type: 'decision',
      prompt: judgePrompt(node, context, r1.text, r2.text),
      exclude: [d1.ref.provider, d2.ref.provider, r1.ref.provider, r2.ref.provider],
    },
    parseJudge,
  );
  if (!judge.ok) return failure(run, 'debate', judge);
  const winner = judge.value.winner === 1 ? r1 : r2;
  return finish(run, 'debate', judge.value.answer ?? winner.text);
}
