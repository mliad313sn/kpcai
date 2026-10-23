/**
 * Executive reports from a program state plus journal-derived metrics (ADR-0031 §5).
 * Honesty rule: a success line is written only with evidence. CI counts only for the
 * exact head commit; a delivered program without that evidence is reported "not verified".
 */
import { ledger } from './ledger.js';
import { spendBySource } from './sources.js';
import { reportText } from './report-text.js';
import type { Locale, ProgramState } from './schemas.js';

/** Figures the host reads from the journal (and CI), never from model output. */
export interface JournalMetrics {
  /** The commit the program's deliverable is at. */
  headCommit?: string;
  ci?: { commit: string; status: 'success' | 'failure' | 'pending'; evidence: string[] };
  tests?: { passed: number; failed: number; evidence: string[] };
  /** Risks from the risk register (program text: quoted). */
  risks?: string[];
}

export type ReportKind = 'digest' | 'milestone' | 'gate' | 'final';

export interface ReportLine {
  text: string;
  evidence: string[];
  /** Model-written text (PO decisions, questions): quoted and shown as such. */
  quoted?: boolean;
  /** Never leaves the machine (local-only memory, D-026 §4): dropped from notifications. */
  localOnly?: boolean;
}

export interface Report {
  kind: ReportKind;
  locale: Locale;
  at: string;
  programId: string;
  title: string;
  headline: string;
  /** True when every success claim in the report has evidence. */
  verified: boolean;
  sections: Array<{ key: string; title: string; lines: ReportLine[] }>;
  link: string;
}

export interface ReportOptions {
  kind: ReportKind;
  now: Date;
  locale?: Locale;
  formatUsd?: (usd: number) => string;
  /** Lines of recent decisions to include (default 10). */
  decisions?: number;
}

const usd2 = (n: number): string => `$${n.toFixed(2)}`;

export function buildReport(s: ProgramState, m: JournalMetrics, o: ReportOptions): Report {
  const locale = o.locale ?? s.charter.reports.locale ?? s.charter.locale;
  const t = reportText(locale);
  const evidence = evidenceLines(m, t);
  const unverified = s.status === 'delivered' ? deliveryGap(m, t) : undefined;
  const sections = [
    { key: 'progress', title: t.sections.progress, lines: progress(s, t) },
    { key: 'evidence', title: t.sections.evidence, lines: evidence },
    { key: 'budget', title: t.sections.budget, lines: budget(s, t, o.formatUsd ?? usd2) },
    { key: 'gates', title: t.sections.gates, lines: gates(s, t) },
    { key: 'decisions', title: t.sections.decisions, lines: decisions(s, t, o.decisions ?? 10) },
    { key: 'waiting', title: t.sections.waiting, lines: waiting(s, t) },
    { key: 'risks', title: t.sections.risks, lines: risks(m, t) },
  ];
  return {
    kind: o.kind,
    locale,
    at: o.now.toISOString(),
    programId: s.charter.programId,
    title: t.title(o.kind, s.charter.programId),
    headline: headline(s, t, unverified),
    verified: unverified === undefined,
    sections,
    link: t.link,
  };
}

type T = ReturnType<typeof reportText>;

/** Why a delivery cannot be called verified, or undefined when the evidence is there. */
export function deliveryGap(m: JournalMetrics, t: T): string | undefined {
  const head = short(m.headCommit);
  if (!m.headCommit || !m.ci || m.ci.commit !== m.headCommit) return t.ciMissing(head);
  if (m.ci.status !== 'success') return t.ciOther(head, m.ci.status);
  if (!m.ci.evidence.length) return t.ciMissing(head);
  if (!m.tests || !m.tests.evidence.length) return t.noTests;
  if (m.tests.failed > 0) return t.tests(m.tests.passed, m.tests.failed);
  return undefined;
}

function headline(s: ProgramState, t: T, gap: string | undefined): string {
  if (s.status === 'delivered')
    return gap ? `${t.status.delivered}. ${t.notVerified(gap)}` : t.delivered;
  const p = s.charter.phases[s.phaseIndex];
  const where = p ? t.phase(s.phaseIndex + 1, s.charter.phases.length, p.title) : '';
  return `${t.status[s.status]}. ${where}`.trim();
}

function progress(s: ProgramState, t: T): ReportLine[] {
  const p = s.charter.phases[s.phaseIndex];
  if (!p) return [];
  const done = p.workPackages.filter((wp) =>
    s.runs.some((r) => r.wpId === wp.id && r.status === 'finished'),
  );
  const ev = s.runs.filter((r) => r.phaseId === p.id).map((r) => `run:${r.runId}`);
  return [{ text: t.wps(done.length, p.workPackages.length), evidence: ev }];
}

/** Commits are shown short: a full 40-hex id reads like a token to the redactor. */
const short = (c: string | undefined): string => (c ? c.slice(0, 12) : '?');

function evidenceLines(m: JournalMetrics, t: T): ReportLine[] {
  const head = short(m.headCommit);
  const ci: ReportLine = !m.ci
    ? { text: t.ciMissing(head), evidence: [] }
    : m.ci.commit !== m.headCommit
      ? { text: t.ciMissing(head), evidence: [] }
      : m.ci.status === 'success' && m.ci.evidence.length
        ? { text: t.ciOk(head), evidence: m.ci.evidence }
        : { text: t.ciOther(head, m.ci.status), evidence: m.ci.evidence };
  const tests: ReportLine = m.tests?.evidence.length
    ? { text: t.tests(m.tests.passed, m.tests.failed), evidence: m.tests.evidence }
    : { text: t.noTests, evidence: [] };
  return [ci, tests];
}

function budget(s: ProgramState, t: T, f: (n: number) => string): ReportLine[] {
  const l = ledger(s);
  const pct = l.totalCapUsd > 0 ? Math.round((l.committedUsd / l.totalCapUsd) * 100) : 0;
  const ev = s.runs.map((r) => `run:${r.runId}`);
  const src = spendBySource(s);
  const quota = s.charter.envelope.subscriptions;
  return [
    { text: t.budgetLine(f(l.spentUsd), f(l.committedUsd), f(l.totalCapUsd), pct), evidence: ev },
    ...l.byPhase.map((p) => ({
      text: t.phaseBudget(p.phaseId, f(p.committedUsd), f(p.capUsd)),
      evidence: [],
    })),
    { text: t.bySource(f(src.apiUsd), src.localHours), evidence: [] },
    ...src.subscriptions.map((x, i) => ({
      text: t.subscription(x.agent, x.runs, String(quota[i]?.runs ?? '∞'), x.hours),
      evidence: [],
    })),
  ];
}

function gates(s: ProgramState, t: T): ReportLine[] {
  if (!s.gates.length) return [{ text: t.noGates, evidence: [] }];
  return s.gates.map((g) => ({
    text: t.gate(g.phaseId, g.verdict, g.reviewer),
    evidence: g.evidence,
  }));
}

function decisions(s: ProgramState, t: T, n: number): ReportLine[] {
  if (!s.decisions.length) return [{ text: t.noDecisions, evidence: [] }];
  return s.decisions.slice(-n).map((d) => ({
    text: t.decision(d.actor, d.text),
    evidence: d.evidence,
    quoted: d.actor === 'po',
  }));
}

function waiting(s: ProgramState, t: T): ReportLine[] {
  const open = s.escalations.filter((x) => !x.answer);
  const amendment = s.amendment ? [{ text: t.status.proposed, evidence: [] }] : [];
  if (!open.length && !amendment.length) return [{ text: t.noWaiting, evidence: [] }];
  return [
    ...amendment,
    ...open.map((x) => ({
      text: t.escalation(x.question),
      evidence: [`escalation:${x.id}`],
      quoted: true,
    })),
  ];
}

function risks(m: JournalMetrics, t: T): ReportLine[] {
  if (!m.risks?.length) return [{ text: t.noRisks, evidence: [] }];
  return m.risks.map((r) => ({ text: r, evidence: [], quoted: true }));
}

/** A digest is due when the cadence says so; gate and milestone reports are event-driven. */
export function digestDue(s: ProgramState, now: Date): boolean {
  const c = s.charter.reports.cadence;
  if (c.every !== 'hours' || s.status === 'draft' || s.status === 'stopped') return false;
  if (!s.lastReportAt) return true;
  return now.getTime() - Date.parse(s.lastReportAt) >= c.hours * 3_600_000;
}

/** Plain Markdown for the RSS/Markdown channel and the Program view. */
export function reportMarkdown(r: Report): string {
  const out = [`# ${r.title}`, '', `**${r.headline}**`, ''];
  for (const sec of r.sections) {
    out.push(`## ${sec.title}`, '');
    for (const l of sec.lines) {
      const ev = l.evidence.length ? ` _(${l.evidence.slice(0, 5).join(', ')})_` : '';
      out.push(`- ${l.text}${ev}`);
    }
    out.push('');
  }
  out.push(r.link, '');
  return out.join('\n');
}
