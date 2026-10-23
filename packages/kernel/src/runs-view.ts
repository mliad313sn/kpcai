/** The runs manager view (R-307): state, cost, worktree, diff size and critic verdict. */
import type { ActiveRun } from './run.js';
import type { RunSummary } from './types.js';
import type { WorkspaceOps } from './workspace-ops.js';

function verdictOf(verdicts: Map<string, boolean>): RunSummary['verdict'] {
  if (verdicts.size === 0) return undefined;
  return [...verdicts.values()].every(Boolean) ? 'approved' : 'changes_requested';
}

export async function summarizeRun(run: ActiveRun, ws: WorkspaceOps): Promise<RunSummary> {
  const o = run.outcome;
  const finished = o?.status === 'finished' ? o : undefined;
  const diff = run.worktree ? await ws.diff(run.runId) : undefined;
  const verdict = verdictOf(run.verdicts);
  return {
    runId: run.runId,
    planId: run.plan.planId,
    sessionId: run.plan.sessionId,
    request: run.plan.request.slice(0, 200),
    state: run.state,
    startedAt: run.startedAt,
    costUsd: finished ? finished.result.costUsd : Math.round(run.costUsd * 1e6) / 1e6,
    isolated: run.workRoot !== undefined,
    ...(run.worktree ? { worktree: run.worktree } : {}),
    ...(diff ? { diff: diff.stats } : {}),
    ...(verdict ? { verdict } : {}),
    patches: finished?.patches.length ?? 0,
    artifacts: finished?.artifacts.length ?? 0,
  };
}
