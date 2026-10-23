/**
 * Reports into the program's archive (`programs/<id>/reports/`): the program package builds
 * them from the state and journal figures; the runtime adds the delivered results with
 * their assurance labels (S10 R5: "verified" means ≥ V2, and each label says what earned
 * it). Outbound channels are WP5's; the archive is the Markdown channel.
 */
import { writeFileSync } from 'node:fs';
import {
  buildReport,
  reportMarkdown,
  withViewed,
  type ProgramState,
  type Report,
  type ReportKind,
} from '@kernelpai/program';
import type { Ctx } from './context.js';
import { newId } from './confirm-gate.js';
import type { ProgramMeta } from './meta.js';

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

function withResults(r: Report, s: ProgramState, m: ProgramMeta): Report {
  const lines = results(s, m).map((x) => ({
    text: `${x.wpId} ${x.status} — ${x.assurance} (${x.basis})`,
    evidence: [`run:${x.runId}`],
  }));
  const title = r.locale === 'fr' ? 'Résultats et niveau de vérification' : 'Results and assurance';
  return {
    ...r,
    sections: [
      ...r.sections,
      { key: 'results', title, lines: lines.length ? lines : [{ text: '—', evidence: [] }] },
    ],
  };
}

/** Builds, archives and announces one report; call inside `locked`. */
export function writeReport(c: Ctx, programId: string, kind: ReportKind, now: Date): string {
  const { state, meta } = c.store.read(programId);
  const report = withResults(buildReport(state, {}, { kind, now }), state, meta);
  const reportId = newId('rep');
  writeFileSync(c.store.file(programId, `reports/${reportId}.md`), reportMarkdown(report), {
    mode: 0o600,
  });
  const entry = {
    reportId,
    kind,
    title: report.title.slice(0, 300),
    at: now.toISOString(),
    verified: report.verified,
    channels: ['markdown'],
  };
  c.store.updateMeta(programId, (m) => void m.reports.push(entry));
  c.store.applyLocked(programId, { type: 'reported' }, 'po', now);
  c.feed.notify('enterprise.report', { programId, ...entry });
  c.feed.line(`${kind} report written`, programId, [{ kind: 'report', id: reportId }], now);
  return reportId;
}
