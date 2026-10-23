import { refToString, type ProtocolResult } from '@kernelpai/core';
import { disputed, type Dispute } from '../dispute.js';
import { parseJudge, type JudgeVerdict } from '../parse.js';
import { debaterPrompt, judgePrompt, rebuttalPrompt } from '../prompts.js';
import type { StepRunner } from '../step.js';
import type { NodeRun, PlannedNode, StepFailed, StepOk } from '../types.js';
import { criticsOf } from './review.js';
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
  const judged = await judgeAll(
    s,
    run,
    r1,
    r2,
    [d1, d2, r1, r2].map((d) => d.ref.provider),
  );
  if (!judged.ok) return failure(run, 'debate', judged);
  const picks = new Set(judged.verdicts.map((v) => v.value.winner));
  if (picks.size > 1) return disputed(run, 'debate', judgeDispute(judged.verdicts, r1, r2));
  const first = judged.verdicts[0] as Judged;
  const winner = first.value.winner === 1 ? r1 : r2;
  return finish(run, 'debate', first.value.answer ?? winner.text);
}

type Judged = { value: JudgeVerdict; step: StepOk };

/**
 * The judges (`node.judges`, else `judges` option, else 1; at most 3), each from a provider
 * not used by the debaters or an earlier judge (principle 2). Extra judges are `strict`;
 * with no new provider the debate goes on with fewer (journaled).
 */
async function judgeAll(
  s: StepRunner,
  run: NodeRun,
  r1: StepOk,
  r2: StepOk,
  debaters: string[],
): Promise<{ ok: true; verdicts: Judged[] } | StepFailed> {
  const wanted = criticsOf((run.node as PlannedNode).judges ?? s.o.judges);
  const verdicts: Judged[] = [];
  const prompt = judgePrompt(run.node, run.context, r1.text, r2.text);
  for (let i = 0; i < wanted; i++) {
    const exclude = [...debaters, ...verdicts.map((v) => v.step.ref.provider)];
    const spec = { role: 'judge' as const, type: 'decision' as const, prompt, exclude };
    const judge = await structured(
      s,
      run,
      i === 0 ? spec : { ...spec, diversity: 'strict' },
      parseJudge,
    );
    if (!judge.ok && judge.diversity && i > 0) {
      s.intervention(run.node.id, {
        action: 'diversity reduced',
        role: 'judge',
        reason: `only ${i} distinct judge provider(s) available for ${wanted} judges`,
      });
      break;
    }
    if (!judge.ok) return judge;
    verdicts.push({ value: judge.value, step: judge.step });
  }
  return { ok: true, verdicts };
}

/** Judges picked different debaters (R-405): each final position is an option. */
function judgeDispute(verdicts: readonly Judged[], r1: StepOk, r2: StepOk): Dispute {
  const option = (w: 1 | 2) => {
    const backers = verdicts.filter((v) => v.value.winner === w);
    const answer = backers.find((v) => v.value.answer)?.value.answer;
    const by = w === 1 ? r1 : r2;
    return {
      id: `debater-${w}`,
      label: `debater ${w} (${refToString(by.ref)}), picked by ${backers.map((v) => refToString(v.step.ref)).join(', ')}`,
      text: answer ?? by.text,
      backers: backers.map((v) => v.step.ref),
    };
  };
  return {
    kind: 'judges',
    reason: `judges disagree on the winner`,
    options: [option(1), option(2)],
    positions: verdicts.map((v) => ({
      ref: v.step.ref,
      role: 'judge' as const,
      says: `winner ${v.value.winner}${v.value.reason ? `: ${v.value.reason}` : ''}`,
      option: `debater-${v.value.winner}`,
    })),
  };
}
