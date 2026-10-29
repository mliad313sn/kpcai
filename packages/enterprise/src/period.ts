/**
 * What a report covers (ADR-0036): the program's accepted transitions since the last report
 * (the `events.jsonl` lines after `meta.reportSeq`, cited as `event:<seq>`), the watchdog
 * alerts of the current heartbeat, every result with its assurance label, test evidence from
 * the runs, the Sponsor's past answer delays and the deadlines of open run questions.
 *
 * Digests follow the charter's cadence (Q-8: daily by default) and are sent only when
 * something changed (S10 R4 b): an unchanged period gives no digest, only a heartbeat
 * entry in the journal and the activity feed, and the cadence starts again.
 */
import {
  buildExecutiveReport,
  digestDue,
  type ExecInput,
  type JournalMetrics,
  type PeriodEvent,
  type ProgramState,
} from '@kernelpai/program';
import type { Ctx } from './context.js';
import { HEARTBEAT_FILE, readHeartbeat } from './liveness.js';
import type { ProgramMeta } from './meta.js';
import { archiveReport, markReported, results } from './reports.js';

/** Accepted transitions after `since` (1-based log lines). */
export function periodEvents(c: Ctx, programId: string, since: number): PeriodEvent[] {
  const { entries } = c.store.history(programId);
  const out: PeriodEvent[] = [];
  entries.forEach((e, i) => {
    if (i < since || e['ok'] !== true || e['event'] === undefined) return;
    out.push({
      seq: i + 1,
      at: String(e['at'] ?? ''),
      actor: String(e['actor'] ?? ''),
      event: e['event'],
    });
  });
  return out;
}

/** Tests from the runs' kernel facts; CI only when a fact for the exact head exists. */
export function journalMetrics(s: ProgramState): JournalMetrics {
  const tested = s.runs.filter((r) => r.purpose === 'work' && r.testsPassed !== undefined);
  if (!tested.length) return {};
  return {
    tests: {
      passed: tested.filter((r) => r.testsPassed).length,
      failed: tested.filter((r) => !r.testsPassed).length,
      evidence: tested.map((r) => `run:${r.runId}`),
    },
  };
}

function deadlines(c: Ctx, s: ProgramState, m: ProgramMeta): Record<string, string> {
  const wait = c.store.config().confirmWaitMinutes * 60_000;
  const out: Record<string, string> = {};
  for (const e of s.escalations)
    if (!e.answer && m.escalations[e.id]?.kind === 'confirm')
      out[e.id] = new Date(Date.parse(e.at) + wait).toISOString();
  return out;
}

export function execInput(
  c: Ctx,
  programId: string,
  s: ProgramState,
  m: ProgramMeta,
  now: Date,
): ExecInput {
  const hb = readHeartbeat(c.store.path(HEARTBEAT_FILE), now);
  const alerts = (hb?.alerts ?? [])
    .filter((a) => a.programId === programId)
    .map((a) => ({ rule: a.rule, text: a.text, evidence: [`heartbeat:${hb!.at}`] }));
  const answerHours = m.answers
    .map((a) => (Date.parse(a.answeredAt) - Date.parse(a.askedAt)) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0);
  return {
    metrics: journalMetrics(s),
    ...(s.lastReportAt ? { since: s.lastReportAt } : {}),
    events: periodEvents(c, programId, m.reportSeq ?? 0),
    alerts,
    results: results(s, m),
    deadlines: deadlines(c, s, m),
    concurrency: c.store.config().portfolio.limits.perProgram,
    ...(answerHours.length ? { answerHours } : {}),
  };
}

/** The cadence counts from the last report, or from the approval for the first digest. */
function due(s: ProgramState, now: Date): boolean {
  if (!digestDue(s, now)) return false;
  const c = s.charter.reports.cadence;
  if (s.lastReportAt || !s.approval || c.every !== 'hours') return true;
  return now.getTime() - Date.parse(s.approval.at) >= c.hours * 3_600_000;
}

/** A digest when due and something changed; otherwise a heartbeat entry. Inside `locked`. */
export function maybeDigest(
  c: Ctx,
  programId: string,
  now: Date,
): 'sent' | 'unchanged' | 'not-due' {
  const { state, meta } = c.store.read(programId);
  if (!due(state, now)) return 'not-due';
  const input = execInput(c, programId, state, meta, now);
  const report = buildExecutiveReport(state, input, { kind: 'digest', now });
  if (report.changed) {
    archiveReport(c, programId, report, now);
    return 'sent';
  }
  c.fact(programId, {
    action: 'digest skipped: no change',
    since: state.lastReportAt ?? state.approval?.at,
    asks: report.counts.asks,
  });
  c.feed.line(`no change since ${state.lastReportAt ?? '-'}: no digest`, programId, [], now);
  markReported(c, programId, now);
  return 'unchanged';
}
