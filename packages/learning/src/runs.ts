/**
 * Splits the journal into runs (ADR-0028). A session can hold several runs one after
 * another; a run ends with its `run outcome` intervention (kernel, P3-F7), which names it.
 * Events after the outcome that carry the run id (checkpoints, restores, merges) and the
 * kernel's own writes (`git.apply`, `fs.write`) that follow them are the run's
 * after-events. Model events of a session with no outcome (a `kpai ask`, a killed run)
 * form an unnamed run keyed `<sessionId>#<seq of its first event>`.
 */
import type { JournalEvent } from '@kernelpai/journal';
import { ACTIONS } from './signals.js';

export interface RunRecord {
  /** The run id, else `<sessionId>#<seq of its first event>`. */
  key: string;
  runId?: string;
  sessionId: string;
  /** The session's working directory: the project key (as `Journal.spend`). */
  project: string;
  /** The plan the run executed (`routing` event with `payload.plan`), when journaled. */
  plan?: JournalEvent;
  /** Events while the run ran, in journal order. */
  events: JournalEvent[];
  /** Events about the run after it ended: writes, checkpoints, restores, merges. */
  after: JournalEvent[];
  outcome?: { status: string; cancelled: boolean; seq: number };
  /** A cancel was journaled while it ran, or the outcome says cancelled. */
  cancelled: boolean;
}

export interface JournalRuns {
  runs: RunRecord[];
  /** `grade` and `bench check` interventions, wherever they were journaled. */
  grades: JournalEvent[];
  byKey: Map<string, RunRecord>;
}

interface SessionState {
  current: RunRecord;
  segments: number;
  /** The run the next kernel write belongs to. */
  pointer?: RunRecord;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function fresh(sessionId: string, project: string, k: number): RunRecord {
  return {
    key: `${sessionId}#${k}`,
    sessionId,
    project,
    events: [],
    after: [],
    cancelled: false,
  };
}

/** Kernel writes (`git.apply`, `fs.write`) are journaled under the `kernel` provider. */
const isKernelWrite = (e: JournalEvent): boolean => e.type === 'tool' && e.provider === 'kernel';

class Splitter {
  private readonly states = new Map<string, SessionState>();
  readonly out: JournalRuns = { runs: [], grades: [], byKey: new Map() };

  constructor(private readonly projectOf: (sessionId: string) => string | undefined) {}

  private state(e: JournalEvent): SessionState {
    let st = this.states.get(e.sessionId);
    if (!st) {
      st = { current: fresh(e.sessionId, this.projectOf(e.sessionId) ?? '', 0), segments: 0 };
      this.states.set(e.sessionId, st);
    }
    return st;
  }

  private close(st: SessionState): void {
    const r = st.current;
    if (r.events.length > 0 || r.outcome) {
      // Keyed by the run id, else by the session and its first event (stable over windows).
      r.key = r.runId ?? `${r.sessionId}#${r.events[0]?.seq ?? 0}`;
      this.out.runs.push(r);
      this.out.byKey.set(r.key, r);
      st.pointer = r;
    }
    st.segments += 1;
    st.current = fresh(r.sessionId, r.project, st.segments);
  }

  add(e: JournalEvent): void {
    const st = this.state(e);
    if (e.type === 'intervention') return this.intervention(st, e);
    if (isKernelWrite(e)) {
      (st.pointer ?? st.current).after.push(e);
      return;
    }
    if (e.type === 'routing' && e.payload.plan !== undefined) {
      if (st.current.events.length > 0) this.close(st);
      st.current.plan = e;
    }
    st.current.events.push(e);
  }

  private intervention(st: SessionState, e: JournalEvent): void {
    const action = str(e.payload.action);
    const runId = str(e.payload.runId);
    if (action === ACTIONS.grade || action === ACTIONS.benchCheck) {
      this.out.grades.push(e);
      return;
    }
    if (action === ACTIONS.outcome && runId) {
      const r = st.current;
      r.runId = runId;
      const cancelled = e.payload.cancelled === true;
      r.outcome = { status: str(e.payload.status) ?? 'failed', cancelled, seq: e.seq };
      r.cancelled ||= cancelled;
      this.close(st);
      return;
    }
    const ended = runId ? this.out.byKey.get(runId) : undefined;
    if (ended) {
      ended.after.push(e);
      st.pointer = ended;
      return;
    }
    const cur = st.current;
    if (runId && cur.runId === undefined) cur.runId = runId;
    if (action === ACTIONS.cancelGraph || action === ACTIONS.cancel) cur.cancelled = true;
    cur.events.push(e);
  }

  finish(): JournalRuns {
    for (const st of this.states.values()) this.close(st);
    return this.out;
  }
}

/**
 * Runs of the given events (journal order), with the project of each session. Pure: the
 * same events always give the same runs (no hidden state, ADR-0028).
 */
export function splitRuns(
  events: readonly JournalEvent[],
  projectOf: (sessionId: string) => string | undefined,
): JournalRuns {
  const s = new Splitter(projectOf);
  for (const e of events) s.add(e);
  return s.finish();
}

/**
 * The run a manual grade names: a run id or its prefix (≥ 6 characters), else a session id
 * or prefix (its last run). Undefined when nothing or more than one run matches.
 */
export function findRun(runs: JournalRuns, id: string): RunRecord | undefined {
  const exact = runs.byKey.get(id);
  if (exact) return exact;
  if (id.length < 6) return undefined;
  const byRun = runs.runs.filter((r) => r.runId?.startsWith(id));
  if (byRun.length === 1) return byRun[0];
  if (byRun.length > 1) return undefined;
  const sessions = new Set(
    runs.runs.filter((r) => r.sessionId.startsWith(id)).map((r) => r.sessionId),
  );
  if (sessions.size !== 1) return undefined;
  return runs.runs.filter((r) => r.sessionId.startsWith(id)).at(-1);
}
