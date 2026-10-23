/**
 * S10 R2 watchdog, pure: what is silently wrong. Silence is alerted, never assumed healthy:
 * a live program with no change, a run with no activity, an old ask, a report overdue, a
 * queue blocked by rate limits. The daemon journals each alert and puts it in the heartbeat.
 */
import type { ProgramState } from './schemas.js';

export interface WatchThresholds {
  /** A running program with no state change and no live run for this long. */
  programStallMinutes: number;
  /** A live run with no kernel activity for this long: a stalled worker. */
  runStallMinutes: number;
  /** An unanswered question older than this. */
  askHours: number;
  /** A digest later than its cadence by this factor. */
  reportOverdueFactor: number;
  /** Jobs held by rate limits for this long. */
  queueBlockedMinutes: number;
}

export const WATCH_DEFAULTS: WatchThresholds = {
  programStallMinutes: 360,
  runStallMinutes: 30,
  askHours: 24,
  reportOverdueFactor: 1.5,
  queueBlockedMinutes: 60,
};

export interface WatchAlert {
  rule:
    | 'program.stalled'
    | 'run.stalled'
    | 'ask.old'
    | 'report.overdue'
    | 'queue.blocked'
    | 'daemon.stale';
  text: string;
  programId?: string;
  runId?: string;
}

export interface WatchInput {
  programs: readonly ProgramState[];
  now: Date;
  /** Last kernel activity per live run id (events, states); default its start. */
  runActivity?: Readonly<Record<string, string>>;
  /** Since when the first pending job has been held by a rate limit, if it is. */
  queueBlockedSince?: string;
}

const MIN = 60_000;

/** Every alert that holds now, in a stable order. */
export function watchdog(i: WatchInput, t: WatchThresholds = WATCH_DEFAULTS): WatchAlert[] {
  const out: WatchAlert[] = [];
  const age = (iso: string): number => i.now.getTime() - Date.parse(iso);
  for (const s of i.programs) {
    const programId = s.charter.programId;
    const live = s.runs.filter((r) => r.status === 'running');
    if (['running', 'gate'].includes(s.status) && !live.length) {
      if (age(s.updatedAt) > t.programStallMinutes * MIN)
        out.push({ rule: 'program.stalled', programId, text: `no change since ${s.updatedAt}` });
    }
    for (const r of live) {
      const last = i.runActivity?.[r.runId] ?? r.startedAt;
      if (age(last) > t.runStallMinutes * MIN)
        out.push({
          rule: 'run.stalled',
          programId,
          runId: r.runId,
          text: `run ${r.runId} silent since ${last}`,
        });
    }
    for (const e of s.escalations) {
      if (!e.answer && age(e.at) > t.askHours * 3_600_000)
        out.push({ rule: 'ask.old', programId, text: `question ${e.id} open since ${e.at}` });
    }
    const overdue = reportOverdue(s, i.now, t.reportOverdueFactor);
    if (overdue) out.push({ rule: 'report.overdue', programId, text: overdue });
  }
  if (i.queueBlockedSince && age(i.queueBlockedSince) > t.queueBlockedMinutes * MIN)
    out.push({
      rule: 'queue.blocked',
      text: `rate limits hold the queue since ${i.queueBlockedSince}`,
    });
  return out;
}

function reportOverdue(s: ProgramState, now: Date, factor: number): string | undefined {
  const c = s.charter.reports.cadence;
  if (c.every !== 'hours' || !['running', 'gate'].includes(s.status)) return undefined;
  const since = s.lastReportAt ?? s.approval?.at;
  if (!since) return undefined;
  const due = Date.parse(since) + c.hours * 3_600_000 * factor;
  return now.getTime() > due ? `digest overdue (last ${since})` : undefined;
}

export interface DeadMan {
  stale: boolean;
  /** Seconds since the last heartbeat; null without one. */
  ageSec: number | null;
}

/** An external checker's view of a heartbeat file: stale when older than `staleAfterSec`. */
export function deadMan(hb: { at: string; staleAfterSec: number } | undefined, now: Date): DeadMan {
  if (!hb || !Number.isFinite(Date.parse(hb.at))) return { stale: true, ageSec: null };
  const ageSec = (now.getTime() - Date.parse(hb.at)) / 1_000;
  return { stale: ageSec > hb.staleAfterSec, ageSec };
}
