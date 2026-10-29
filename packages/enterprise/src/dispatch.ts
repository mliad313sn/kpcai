/**
 * Jobs to runs and back (ADR-0035): the scheduler picks, the envelope decides (`delegate`
 * plans, checks the band top and starts only on allow), the machine records the start
 * again under the lock (defence in depth), and the run's typed result settles it. A start
 * the machine refuses is cancelled at once and journaled: no run lives unrecorded.
 */
import type { RunOutcome } from '@kernelpai/kernel';
import {
  delegate,
  policyBreach,
  policyFor,
  settleEvent,
  settled,
  started as startedQueue,
  type Pick,
  type Queue,
  type RunResult,
} from '@kernelpai/program';
import { cleanFinish, runAssurance } from './assure.js';
import { newId } from './confirm-gate.js';
import { classOf } from '@kernelpai/learning';
import { cancelRun, type Ctx, type LiveRun } from './context.js';
import { pauseFor } from './program-step.js';
import type { StartedHandle } from './starter.js';

/** A review job is keyed by its phase id; a work job by its work package id. */
export function purposeOf(c: Ctx, programId: string, wpId: string): 'work' | 'review' {
  const { state } = c.store.read(programId);
  return state.charter.phases.some((p) => p.id === wpId) ? 'review' : 'work';
}

function dropJob(q: Queue, jobId: string): Queue {
  return { ...q, pending: q.pending.filter((j) => j.id !== jobId) };
}

/** Delegates one picked job; never throws (a failure drops the job, journaled). */
export async function launch(c: Ctx, pick: Pick): Promise<void> {
  const { job } = pick;
  const purpose = purposeOf(c, job.programId, job.wpId);
  try {
    const { state } = c.store.read(job.programId);
    const now = c.clock();
    const portfolio = c.store.config().portfolio.sources;
    const d = await delegate(state, job.wpId, c.starter, {
      now,
      purpose,
      escalationId: newId('esc'),
      ...(portfolio ? { portfolio } : {}),
    });
    await c.store.locked(() => record(c, pick, d, now));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    c.starter.forgetWp(job.programId, job.wpId);
    await c.store.locked(() => c.store.saveQueue(dropJob(c.store.queue(), job.id)));
    c.feed.line(`${job.wpId}: not started (${why.slice(0, 200)})`, job.programId);
  } finally {
    c.inflight.delete(job.id);
  }
}

type Delegation = Awaited<ReturnType<typeof delegate>>;

function record(c: Ctx, pick: Pick, d: Delegation, now: Date): void {
  if (d.outcome === 'started') return recordStart(c, pick, d, now);
  const { job } = pick;
  const pid = job.programId;
  c.store.saveQueue(dropJob(c.store.queue(), job.id));
  c.starter.forgetWp(pid, job.wpId);
  if (d.outcome === 'escalated') {
    const t = c.store.applyLocked(pid, d.event, 'po', now);
    if (t.ok && d.event.type === 'escalate') {
      const id = d.event.escalation.id;
      c.store.updateMeta(pid, (m) => void (m.escalations[id] = { kind: 'run', evidence: [] }));
      c.feed.notify('enterprise.inbox', { programId: pid, escalationId: id, state: 'open' });
      const text = `${job.wpId} waits for you: ${d.verdict.reason}`;
      c.feed.line(text, pid, [{ kind: 'escalation', id }], now);
    }
    return;
  }
  c.fact(pid, { action: 'run refused by the envelope', wpId: job.wpId, rule: d.verdict.rule });
  c.feed.line(`${job.wpId} refused: ${d.verdict.reason}`, pid, [], now);
}

function recordStart(
  c: Ctx,
  pick: Pick,
  d: Extract<Delegation, { outcome: 'started' }>,
  now: Date,
): void {
  const { job } = pick;
  const pid = job.programId;
  const run = d.event.type === 'run.started' ? d.event.run : undefined;
  const t = c.store.applyLocked(pid, d.event, 'kernel', now);
  if (run) c.live.get(run.runId)?.markReady();
  if (!t.ok || !run) {
    // The program changed meanwhile (paused, stopped): the run must not live unrecorded.
    if (run) cancelRun(c, run.runId);
    c.fact(pid, {
      action: 'run cancelled: not recorded',
      runId: run?.runId,
      reason: t.ok ? '' : t.reason,
    });
    c.store.saveQueue(dropJob(c.store.queue(), job.id));
    return;
  }
  const live = c.live.get(run.runId);
  if (live) live.jobId = job.id;
  c.store.updateMeta(pid, (m) => {
    const r = m.runs[run.runId];
    if (r) r.jobId = job.id;
  });
  c.store.saveQueue(startedQueue(c.store.queue(), [pick], now));
  c.feed.notify('enterprise.wp', {
    programId: pid,
    wpId: job.wpId,
    from: 'queued',
    to: pick.provider,
    state: run.purpose === 'review' ? 'review' : 'running',
  });
  c.feed.line(
    `${job.wpId} started (band top $${run.capUsd.toFixed(2)}, ${run.providers.join(', ')})`,
    pid,
    [{ kind: 'run', id: run.runId }],
    now,
  );
}

/** Called by the starter when the kernel accepted a run: watch it until it settles. */
export function watch(c: Ctx, s: StartedHandle): void {
  const runId = s.handle.runId;
  const at = c.clock().toISOString();
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((r) => (markReady = r));
  const base = { programId: s.ctx.programId, wpId: s.ctx.wpId, sessionId: s.sessionId };
  c.live.set(runId, { ...base, startedAt: at, ready, markReady });
  c.activity.set(runId, at);
  // The session is known before the machine records the run: a crash keeps it findable.
  void c.store.locked(() =>
    c.store.updateMeta(s.ctx.programId, (m) => {
      m.runs[runId] = {
        sessionId: s.sessionId,
        planId: s.planId,
        wpId: s.ctx.wpId,
        purpose: purposeOf(c, s.ctx.programId, s.ctx.wpId),
      };
    }),
  );
  // A settlement in progress is tracked from the moment the run ends (`idle` waits for it).
  const track = (o: RunOutcome | undefined): void => {
    const p = settle(c, runId, o).catch((err: unknown) => {
      const why = err instanceof Error ? err.message : String(err);
      c.fact(s.ctx.programId, { action: 'settlement failed', runId, reason: why.slice(0, 300) });
    });
    c.settling.add(p);
    void p.finally(() => c.settling.delete(p));
  };
  s.handle.done.then(track, () => track(undefined));
}

/** The typed result of a run: status, cost from the journal, assurance from the journal. */
export function resultOf(
  c: Ctx,
  runId: string,
  sessionId: string,
  o: RunOutcome | undefined,
): RunResult & { basis: string } {
  const status: RunResult['status'] = !o
    ? 'failed'
    : o.status === 'not_run'
      ? 'not_run'
      : o.cancelled
        ? 'cancelled'
        : cleanFinish(o)
          ? 'finished'
          : 'failed';
  const a = runAssurance(c.kernel, sessionId, runId, o);
  const evidence = [
    `session:${sessionId}`,
    ...(o?.status === 'finished' && o.worktree ? ['worktree'] : []),
  ];
  return {
    runId,
    status,
    costUsd: c.kernel.sessionSpendUsd(sessionId),
    evidence,
    ...(a.label !== 'V3' ? { assurance: a.label } : {}),
    ...(a.testsPassed !== undefined ? { testsPassed: a.testsPassed } : {}),
    ...usedBy(o),
    basis: a.basis,
  };
}

/**
 * What the run really used and delivered (ADR-0033 D-028 outcome fields): the providers
 * that served its steps, with their source (P5-F3), and whether its outputs are code or
 * documents (P5-F8, docs/metrics/NORTH-STAR.md classes).
 */
function usedBy(o: RunOutcome | undefined): {
  sources?: RunResult['sources'];
  deliverable?: RunResult['deliverable'];
} {
  if (o?.status !== 'finished') return {};
  const files = [...o.patches.flatMap((p) => p.files), ...o.artifacts.map((a) => a.path)];
  const kind = o.patches.length ? 'patch' : o.artifacts.length ? 'artifact' : 'merge';
  const delivered = o.patches.length + o.artifacts.length > 0;
  return {
    ...(o.sources?.length ? { sources: o.sources } : {}),
    ...(delivered ? { deliverable: classOf({ kind, files }) } : {}),
  };
}

/**
 * P5-F3: a run that used a provider outside its work package's policy (the portfolio's
 * level included) fails closed, and the Sponsor is asked. Inside `locked`.
 */
function failOutsidePolicy(c: Ctx, live: LiveRun, r: RunResult): string[] {
  const { state } = c.store.read(live.programId);
  const policy = policyFor(state.charter, live.wpId, c.store.config().portfolio.sources);
  const breach = policyBreach(policy, r);
  if (!breach.length) return breach;
  if (r.status === 'finished') r.status = 'failed';
  r.evidence.push(...breach.map((b) => `policy-breach:${b}`));
  c.fact(live.programId, { action: 'run outside its source policy', runId: r.runId, breach });
  return breach;
}

function askAboutBreach(c: Ctx, live: LiveRun, runId: string, breach: string[], now: Date): void {
  pauseFor(c, live.programId, now, {
    kind: 'policy',
    rule: 'source.policy.breach',
    question: `${live.wpId}: run ${runId} used ${breach.join(', ')}, outside its source policy. It was failed closed and its output is not used. Resume the program?`,
    evidence: [{ kind: 'run', id: runId }],
  });
}

async function settle(c: Ctx, runId: string, o: RunOutcome | undefined): Promise<void> {
  const live = c.live.get(runId);
  if (!live) return;
  await Promise.race([live.ready, new Promise((r) => setTimeout(r, 30_000).unref())]);
  const r = resultOf(c, runId, live.sessionId, o);
  // P5-R1: a run cancelled (or killed, stopped) while it waited on its start question is
  // cancelled, not "not run".
  const voided = c.gate.takeVoided(runId);
  if ((live.guard === 'cancelled' || voided) && r.status === 'not_run') r.status = 'cancelled';
  const now = c.clock();
  await c.store.locked(() => {
    const breach = failOutsidePolicy(c, live, r);
    const t = c.store.applyLocked(live.programId, settleEvent(r), 'kernel', now);
    if (breach.length) askAboutBreach(c, live, runId, breach, now);
    c.store.updateMeta(live.programId, (m) => {
      const x = m.runs[runId];
      if (x) {
        x.basis = r.basis;
        if (o?.status === 'finished' && o.worktree) x.worktree = o.worktree;
      }
    });
    const jobId = live.jobId ?? c.store.read(live.programId).meta.runs[runId]?.jobId;
    if (jobId) c.store.saveQueue(settled(c.store.queue(), jobId, r.costUsd));
    if (!t.ok) c.fact(live.programId, { action: 'settlement refused', runId, reason: t.reason });
  });
  c.live.delete(runId);
  c.activity.delete(runId);
  c.feed.notify('enterprise.wp', {
    programId: live.programId,
    wpId: live.wpId,
    from: 'running',
    to: r.status,
    state: r.status === 'finished' ? 'done' : 'held',
  });
  c.feed.line(
    `${live.wpId} ${r.status}, $${r.costUsd.toFixed(4)}, ${r.assurance ?? 'V0'}`,
    live.programId,
    [{ kind: 'run', id: runId }],
    now,
  );
}
