/**
 * Restart reconciliation (R-507, R-5E4, ADR-0035). A run recorded `running` that this
 * process did not start was cut by a crash or a restart: it is settled `cancelled` with
 * the evidence `interrupted:restart` and its real cost from its journal session (its band
 * top when the session is unknown: never under-counted). Its work package is then planned
 * again and checked by the envelope like any new run: nothing is re-spent silently, and no
 * run id ever starts twice.
 */
import { settled } from '@kernelpai/program';
import type { Ctx } from './context.js';

export interface Recovered {
  programId: string;
  runId: string;
  costUsd: number;
}

function costOf(c: Ctx, sessionId: string | undefined, capUsd: number): number {
  if (!sessionId) return capUsd;
  try {
    return c.kernel.sessionSpendUsd(sessionId);
  } catch {
    return capUsd;
  }
}

/** Settles every interrupted run and frees its queue slot; call once at start, locked. */
export function recoverInterrupted(c: Ctx, now: Date): Recovered[] {
  const out: Recovered[] = [];
  let q = c.store.queue();
  for (const id of c.store.ids()) {
    const { state, meta } = c.store.read(id);
    for (const run of state.runs) {
      if (run.status !== 'running' || c.live.has(run.runId)) continue;
      const known = meta.runs[run.runId];
      const costUsd = costOf(c, known?.sessionId, run.capUsd);
      const event = {
        type: 'run.settled',
        runId: run.runId,
        status: 'cancelled',
        costUsd,
        evidence: ['interrupted:restart', ...(known ? [`session:${known.sessionId}`] : [])],
        assurance: 'V0',
      };
      const t = c.store.applyLocked(id, event, 'kernel', now);
      if (!t.ok) continue;
      if (known?.jobId) q = settled(q, known.jobId, costUsd);
      out.push({ programId: id, runId: run.runId, costUsd });
      c.fact(id, { action: 'run interrupted', runId: run.runId, costUsd, replanned: true });
      c.feed.line(
        `${run.wpId}: run ${run.runId} was interrupted by a restart ($${costUsd.toFixed(4)} counted); it will be planned again within the envelope`,
        id,
        [{ kind: 'run', id: run.runId }],
        now,
      );
    }
  }
  // Nothing runs in a process that just started: any slot left is freed, its band top
  // counted as spent (its run was never matched to a session: never under-counted).
  const stale = q.running.reduce((a, r) => a + r.job.capUsd, 0);
  q = { ...q, running: [], spentUsd: q.spentUsd + stale };
  c.store.saveQueue(q);
  return out;
}
