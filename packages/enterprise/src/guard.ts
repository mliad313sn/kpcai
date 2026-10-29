/**
 * The daemon's run guard (P5-F1, D-035): the kill switch and a program's stop or pause may
 * come from another process on the same `$KPAI_HOME` (`kpai studio`, `kpai program stop`),
 * which cannot reach this process's kernel runs. So the daemon reads the store on every
 * tick and on a short timer of its own, and acts on the runs it started: the kill switch
 * and a stopped (or ended) program cancel them; a paused program pauses them (nothing new
 * is scheduled, steps in flight finish) and resumes them when the program runs again.
 * Each action is journaled once. Read-only on the store: files are replaced atomically.
 * A cancel also ends the questions the run waits on (P5-R1): the gate expires them, so the
 * run settles at once and a late yes is refused. A pause keeps them (resumable), but they
 * cannot be answered until the program runs again (`Sponsor.answer`).
 */
import { attempt, type Ctx, type LiveRun } from './context.js';

/** How often a started daemon checks, at most (its tick may be longer). */
export const GUARD_MS = 250;

type Want = 'cancel' | 'pause' | 'resume' | undefined;

function wanted(c: Ctx, live: LiveRun, killed: boolean): { want: Want; why: string } {
  if (killed) return { want: 'cancel', why: 'kill switch on' };
  let status: string;
  try {
    status = c.store.read(live.programId).state.status;
  } catch {
    return { want: undefined, why: '' };
  }
  if (status === 'stopped' || status === 'delivered')
    return { want: 'cancel', why: `program ${status}` };
  if (status === 'paused') return { want: 'pause', why: 'program paused' };
  if (live.guard === 'paused') return { want: 'resume', why: `program ${status}` };
  return { want: undefined, why: '' };
}

function act(
  c: Ctx,
  runId: string,
  live: LiveRun,
  want: Exclude<Want, undefined>,
  why: string,
): boolean {
  if (want === 'cancel') {
    const done = attempt(() => c.kernel.cancel(runId));
    // A run the kernel no longer knows, or one already winding down, is not asked again.
    live.guard = 'cancelled';
    // P5-R1: a question the run waits on ends now, as a no, and expires in the inbox.
    c.gate.abandon(runId, why);
    return done === true;
  }
  if (want === 'pause') {
    if (live.guard === 'paused') return false;
    // A run still in its budget check cannot be paused yet: tried again next check.
    if (attempt(() => (c.kernel.pause(runId), true)) !== true) return false;
    live.guard = 'paused';
    return true;
  }
  if (attempt(() => (c.kernel.resume(runId), true)) !== true) return false;
  delete live.guard;
  return true;
}

/** One check: returns the run ids acted on, by action. */
export function guardRuns(c: Ctx): Record<'cancel' | 'pause' | 'resume', string[]> {
  const out = { cancel: [] as string[], pause: [] as string[], resume: [] as string[] };
  if (!c.live.size) return out;
  // An unreadable portfolio.json stops new starts (the pass fails) but cancels nothing.
  const killed = attempt(() => c.store.config().portfolio.killSwitch) === true;
  for (const [runId, live] of c.live) {
    if (live.guard === 'cancelled') continue;
    const { want, why } = wanted(c, live, killed);
    if (!want || !act(c, runId, live, want, why)) continue;
    out[want].push(runId);
    const action = { cancel: 'run cancelled', pause: 'run paused', resume: 'run resumed' }[want];
    c.fact(live.programId, { action: `${action} by the daemon`, runId, wpId: live.wpId, why });
    c.feed.line(
      `${live.wpId}: ${action} (${why})`,
      live.programId,
      [{ kind: 'run', id: runId }],
      c.clock(),
    );
  }
  return out;
}
