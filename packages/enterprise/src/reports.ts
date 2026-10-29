/**
 * Reports into the program's archive (`programs/<id>/reports/`, ADR-0036): the program
 * package builds the executive report (asks, changes, forecast, top risk) from the state,
 * the period's log lines and journal figures; the runtime adds the delivered results with
 * their assurance labels (S10 R5: "verified" means ≥ V2, and each label says what earned
 * it). Each report is then queued for the outbound channels (`channels/outbox.ts`).
 */
import { writeFileSync } from 'node:fs';
import {
  buildExecutiveReport,
  reportMarkdown,
  withViewed,
  type ExecReport,
  type ProgramState,
  type ReportKind,
} from '@kernelpai/program';
import type { Ctx } from './context.js';
import { newId } from './confirm-gate.js';
import type { ProgramMeta } from './meta.js';
import { execInput } from './period.js';

export interface ResultLine {
  programId: string;
  wpId: string;
  runId: string;
  status: string;
  assurance: 'V0' | 'V1' | 'V2' | 'V3';
  basis: string;
}

/** Every settled run with its label; V3 when a human opened a V2 run's evidence. */
export function results(s: ProgramState, m: ProgramMeta): ResultLine[] {
  return (
    s.runs
      // Delivered results: work runs; a gate review is evidence, not a deliverable.
      .filter((r) => r.status !== 'running' && r.purpose === 'work')
      .map((r) => {
        const viewed = m.viewed.some((v) => v.ref.kind === 'run' && v.ref.id === r.runId);
        const assurance = withViewed(r.assurance, viewed);
        const basis = m.runs[r.runId]?.basis ?? `${r.assurance ?? 'V0'}: no journal facts`;
        return {
          programId: s.charter.programId,
          wpId: r.wpId,
          runId: r.runId,
          status: r.status,
          assurance,
          basis: assurance === 'V3' ? `${basis}; evidence opened` : basis,
        };
      })
  );
}

/** Builds, archives and announces one report; call inside `locked`. */
export function writeReport(c: Ctx, programId: string, kind: ReportKind, now: Date): string {
  const { state, meta } = c.store.read(programId);
  const report = buildExecutiveReport(state, execInput(c, programId, state, meta, now), {
    kind,
    now,
  });
  return archiveReport(c, programId, report, now);
}

/** Writes the Markdown file, lists it in the archive, moves the cursor, queues the notices. */
export function archiveReport(c: Ctx, programId: string, report: ExecReport, now: Date): string {
  const reportId = newId('rep');
  writeFileSync(c.store.file(programId, `reports/${reportId}.md`), reportMarkdown(report), {
    mode: 0o600,
  });
  const entry = {
    reportId,
    kind: report.kind,
    title: report.title.slice(0, 300),
    at: now.toISOString(),
    verified: report.verified,
    channels: ['markdown'],
  };
  c.store.updateMeta(programId, (m) => void m.reports.push(entry));
  markReported(c, programId, now);
  c.feed.notify('enterprise.report', { programId, ...entry });
  c.feed.line(`${report.kind} report written`, programId, [{ kind: 'report', id: reportId }], now);
  c.outbox.push({ kind: 'report', programId, reportId, report });
  return reportId;
}

/** `reported` resets the cadence; the cursor moves past it. */
export function markReported(c: Ctx, programId: string, now: Date): void {
  c.store.applyLocked(programId, { type: 'reported' }, 'po', now);
  const seq = c.store.history(programId).entries.length;
  c.store.updateMeta(programId, (m) => void (m.reportSeq = seq));
}
