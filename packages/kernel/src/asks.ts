/**
 * S10 R6 J2 (B-28, B-37): every question a run asks the human, journaled once answered with
 * when it reached them, when they answered, what they answered, whether it was
 * consequential and whether the exact diff was shown with it. Read by the attention and
 * rubber-stamp guardrail (G2, docs/metrics/NORTH-STAR.md). Never the question text.
 */
import type { Journal } from '@kernelpai/journal';
import type { AskTimes, ConfirmRequest } from './confirm.js';

export const ASK_ACTION = 'confirmation answered';

/**
 * Consequential (S10 R8, METRICS-NORTH-STAR G2): a write to the user's own tree, a restore,
 * a spend question, a destructive or physical step. Writes into a run's worktree, memory
 * and read or write tool calls are trivial.
 */
export function consequentialAsk(req: ConfirmRequest): boolean {
  if (req.physical === true || req.risk === 'destructive') return true;
  if (req.kind === 'budget' || req.kind === 'restore' || req.kind === 'dispute') return true;
  if (req.kind === 'patch' || req.kind === 'artifact') return req.inWorktree !== true;
  return false;
}

/**
 * The journaled record of one answered question (J2): kind, risk, the times, the answer,
 * and `viewed: 'diff'` when the exact diff or content was shown with the question. Never
 * the question text, the diff or the content.
 */
export function askRecord(req: ConfirmRequest, a: AskTimes): Record<string, unknown> {
  return {
    action: ASK_ACTION,
    ...(req.runId ? { runId: req.runId } : {}),
    kind: req.kind,
    ...(req.risk ? { risk: req.risk } : {}),
    consequential: consequentialAsk(req),
    answer: a.yes ? 'yes' : 'no',
    askedAt: a.askedAt.toISOString(),
    answeredAt: a.answeredAt.toISOString(),
    viewed: req.patch !== undefined || req.content !== undefined ? 'diff' : 'none',
  };
}

/**
 * Journals each answered question of a known run in that run's session (J2). A question
 * outside a run (workspace guard, memory, scope) has no session here and is not recorded.
 */
export function askJournal(
  journal: () => Journal,
  runs: ReadonlyMap<string, { plan: { sessionId: string } }>,
): (req: ConfirmRequest, a: AskTimes) => void {
  return (req, a) => {
    const sessionId = req.runId ? runs.get(req.runId)?.plan.sessionId : undefined;
    if (sessionId)
      journal().append({ sessionId, type: 'intervention', payload: askRecord(req, a) });
  };
}
