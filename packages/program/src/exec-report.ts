/**
 * Executive report v2 (S10 R4, R-5E8, ADR-0036): a fixed order, asks first —
 * what needs your answer → what changed → forecast with an interval → top risk — then,
 * for gate, milestone and final reports, every result with its assurance label (R5).
 *
 * Honesty rules: every claim carries journal evidence (`run:`, `event:<seq>`,
 * `escalation:`, `ci:`); "delivered" reads "verified" only with CI green for the exact head
 * commit and passing tests (`deliveryGap`, ADR-0031); model text is quoted. Pure.
 */
import { execText, type Counts, type ExecText } from './exec-text.js';
import { forecast, type Forecast } from './forecast.js';
import { ledger } from './ledger.js';
import { ProgramEventSchema, type ProgramEvent } from './events.js';
import {
  deliveryGap,
  type JournalMetrics,
  type Report,
  type ReportKind,
  type ReportLine,
} from './report.js';
import { reportText } from './report-text.js';
import { spendBySource } from './sources.js';
import type { Assurance, Locale, ProgramState } from './schemas.js';

/** One accepted transition of the program's log since the last report. */
export interface PeriodEvent {
  /** Line number in `events.jsonl` (1-based): the journal sequence cited as `event:<seq>`. */
  seq: number;
  at: string;
  actor: string;
  event: unknown;
}

export interface ResultLabel {
  runId: string;
  wpId: string;
  status: string;
  assurance: Assurance;
  basis: string;
}

export interface ExecInput {
  metrics?: JournalMetrics;
  /** Start of the period; undefined for the first report. */
  since?: string;
  events: readonly PeriodEvent[];
  /** Watchdog alerts new in the period, with the journal reference of each. */
  alerts?: ReadonlyArray<{ rule: string; text: string; evidence: string[] }>;
  results?: readonly ResultLabel[];
  /** Per open question: when silence becomes a no (runtime confirm questions). */
  deadlines?: Readonly<Record<string, string>>;
  concurrency?: number;
  answerHours?: readonly number[];
}

export interface ExecOptions {
  kind: ReportKind;
  now: Date;
  locale?: Locale;
}

export interface ExecReport extends Report {
  counts: Counts;
  /** False when the period holds no change of note and no alert (a digest is then skipped). */
  changed: boolean;
  forecast: Forecast;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;
const NOTED = new Set(['reported', 'propose', 'reject']);

export function buildExecutiveReport(s: ProgramState, i: ExecInput, o: ExecOptions): ExecReport {
  const locale = o.locale ?? s.charter.reports.locale ?? s.charter.locale;
  const t = execText(locale);
  const fc = forecast(s, {
    now: o.now,
    ...(i.concurrency ? { concurrency: i.concurrency } : {}),
    ...(i.answerHours ? { answerHours: i.answerHours } : {}),
  });
  const changes = periodChanges(s, i, t);
  const alerts = i.alerts ?? [];
  const asks = askLines(s, i, o.now, t);
  const l = ledger(s);
  const counts: Counts = {
    asks: asks.filter((x) => x.evidence.length).length,
    budgetPct: l.totalCapUsd > 0 ? Math.round((l.committedUsd / l.totalCapUsd) * 100) : 0,
    alerts: alerts.length,
    changes: changes.length,
  };
  const gap =
    s.status === 'delivered' ? deliveryGap(i.metrics ?? {}, reportText(locale)) : undefined;
  const sections = [
    { key: 'asks', title: t.sections.asks, lines: asks },
    {
      key: 'changes',
      title: t.sections.changes,
      lines: orNone(changes, t.noChanges(i.since ?? s.approval?.at ?? '-')),
    },
    { key: 'forecast', title: t.sections.forecast, lines: forecastLines(s, fc, t) },
    { key: 'risk', title: t.sections.risk, lines: [topRisk(s, fc, i, o.now, t)] },
    ...(o.kind === 'digest'
      ? []
      : [{ key: 'results', title: t.sections.results, lines: resultLines(i.results ?? [], t) }]),
  ];
  return {
    kind: o.kind,
    locale,
    at: o.now.toISOString(),
    programId: s.charter.programId,
    title: reportText(locale).title(o.kind, s.charter.programId),
    headline: headline(s, locale, counts, gap, i.metrics),
    verified: gap === undefined,
    sections,
    link: reportText(locale).link,
    counts,
    changed: changes.length > 0 || alerts.length > 0,
    forecast: fc,
  };
}

const orNone = (lines: ReportLine[], none: string): ReportLine[] =>
  lines.length ? lines : [{ text: none, evidence: [] }];

/** Asks in the first sentence (R4 d); a delivery says whether it is verified, and why not. */
function headline(
  s: ProgramState,
  locale: Locale,
  c: Counts,
  gap: string | undefined,
  m: JournalMetrics | undefined,
): string {
  const t = execText(locale);
  const r = reportText(locale);
  if (s.status === 'delivered') {
    if (gap !== undefined || !m?.tests)
      return `${r.status.delivered}. ${r.notVerified(gap ?? r.noTests)}`;
    const head = (m?.headCommit ?? '').slice(0, 12);
    return `${r.delivered}: ${r.ciOk(head)}, ${r.tests(m.tests.passed, m.tests.failed)}.`;
  }
  const p = s.charter.phases[s.phaseIndex];
  const where = p ? r.phase(s.phaseIndex + 1, s.charter.phases.length, p.title) : '';
  return [t.asksLead(c.asks), `${r.status[s.status]}.`, where].filter(Boolean).join(' ');
}

function askLines(s: ProgramState, i: ExecInput, now: Date, t: ExecText): ReportLine[] {
  const open = s.escalations.filter((e) => !e.answer);
  const silent = (id: string): string => {
    const d = i.deadlines?.[id];
    if (d && Date.parse(d) > now.getTime()) return t.silentNo(d);
    return s.status === 'paused' ? t.silentPaused : t.silentWaits;
  };
  const lines: ReportLine[] = open.map((e) => ({
    text: t.ask(e.question.slice(0, 300), silent(e.id)),
    evidence: [`escalation:${e.id}`],
    quoted: true,
  }));
  if (s.amendment) lines.unshift({ text: t.amendment, evidence: ['amendment:pending'] });
  return orNone(lines, t.noAsks);
}

/** Lines for the transitions of the period, each citing its log sequence. */
export function periodChanges(s: ProgramState, i: ExecInput, t: ExecText): ReportLine[] {
  const labels = new Map((i.results ?? []).map((r) => [r.runId, r]));
  const out: ReportLine[] = [];
  for (const pe of i.events) {
    const p = ProgramEventSchema.safeParse(pe.event);
    if (!p.success || NOTED.has(p.data.type)) continue;
    const line = changeLine(p.data, pe, s, labels, t);
    if (line) out.push({ ...line, evidence: [`event:${pe.seq}`, ...line.evidence] });
  }
  for (const a of i.alerts ?? [])
    out.push({ text: t.alert(a.rule, a.text.slice(0, 200)), evidence: a.evidence });
  return out;
}

function changeLine(
  e: ProgramEvent,
  pe: PeriodEvent,
  s: ProgramState,
  labels: Map<string, ResultLabel>,
  t: ExecText,
): ReportLine | undefined {
  switch (e.type) {
    case 'start':
      return { text: t.started, evidence: [] };
    case 'approve':
      return { text: t.approved, evidence: [] };
    case 'run.started':
      return {
        text: t.runStarted(e.run.wpId, e.run.purpose, usd(e.run.capUsd)),
        evidence: [`run:${e.run.runId}`],
      };
    case 'run.settled':
      return settledLine(e, s, labels, t);
    case 'gate.open':
      return { text: t.gateOpen(s.charter.phases[s.phaseIndex]?.id ?? '?'), evidence: [] };
    case 'gate.close':
      return {
        text: t.gateClosed(e.record.phaseId, e.record.verdict),
        evidence: e.record.evidence.slice(0, 5),
      };
    case 'pause':
    case 'resume':
    case 'stop':
      return { text: t.status(e.type, pe.actor), evidence: [] };
    case 'decide':
      return {
        text: t.decision(pe.actor, e.decision.text.slice(0, 200)),
        evidence: e.decision.evidence.slice(0, 5),
        quoted: pe.actor !== 'sponsor',
      };
    case 'escalate':
      return { text: t.asked(e.escalation.rule), evidence: [`escalation:${e.escalation.id}`] };
    case 'answer':
      return { text: t.answered(e.id, e.answer), evidence: [`escalation:${e.id}`] };
    default:
      return { text: t.amend(e.type), evidence: [] };
  }
}

function settledLine(
  e: Extract<ProgramEvent, { type: 'run.settled' }>,
  s: ProgramState,
  labels: Map<string, ResultLabel>,
  t: ExecText,
): ReportLine {
  const run = s.runs.find((r) => r.runId === e.runId);
  const label = labels.get(e.runId);
  const assurance = label?.assurance ?? e.assurance ?? 'V0';
  const basis = label?.basis ?? `${assurance}: no journal facts`;
  return {
    text: t.runSettled(run?.wpId ?? '?', e.status, assurance, basis.slice(0, 200)),
    evidence: [`run:${e.runId}`, ...e.evidence.slice(0, 3)],
  };
}

function forecastLines(s: ProgramState, fc: Forecast, t: ExecText): ReportLine[] {
  const r = reportText(s.charter.reports.locale ?? s.charter.locale);
  const l = ledger(s);
  const pct = l.totalCapUsd > 0 ? Math.round((l.committedUsd / l.totalCapUsd) * 100) : 0;
  const src = spendBySource(s);
  const runs = s.runs.slice(-20).map((x) => `run:${x.runId}`);
  const lines: ReportLine[] = [
    {
      text: r.budgetLine(usd(l.spentUsd), usd(l.committedUsd), usd(l.totalCapUsd), pct),
      evidence: runs,
    },
    { text: r.bySource(usd(src.apiUsd), src.localHours), evidence: runs },
  ];
  if (!fc.remainingRuns && !fc.liveRuns) return [...lines, { text: t.fcDone, evidence: runs }];
  lines.push({ text: t.fcRemaining(fc.remainingRuns, fc.liveRuns), evidence: runs });
  if (!fc.costUsd) return [...lines, { text: t.fcNoHistory(usd(fc.capUsd)), evidence: runs }];
  lines.push({
    text: t.fcCost(usd(fc.costUsd.low), usd(fc.costUsd.high), fc.wide),
    evidence: fc.evidence,
  });
  if (fc.finish)
    lines.push({
      text: t.fcDate(fc.finish.low, fc.finish.high, fc.answersIncluded),
      evidence: fc.evidence,
    });
  return lines;
}

/** One risk, the most pressing first: alerts, cap, expiry, unverified results, old asks. */
function topRisk(s: ProgramState, fc: Forecast, i: ExecInput, now: Date, t: ExecText): ReportLine {
  const alert = i.alerts?.[0];
  if (alert) return { text: t.riskAlert(alert.rule), evidence: alert.evidence };
  if (fc.costUsd && fc.costUsd.high > fc.capUsd + 1e-9)
    return { text: t.riskOverCap(usd(fc.costUsd.high), usd(fc.capUsd)), evidence: fc.evidence };
  const exp = s.charter.envelope.expires;
  const live = !['delivered', 'stopped'].includes(s.status);
  if (live && exp && Date.parse(exp) - now.getTime() < 48 * 3_600_000)
    return { text: t.riskExpiry(exp), evidence: ['charter:envelope.expires'] };
  const weak = (i.results ?? []).filter(
    (r) => r.status === 'finished' && (r.assurance === 'V0' || r.assurance === 'V1'),
  );
  if (weak.length)
    return {
      text: t.riskUnverified(weak.length),
      evidence: weak.map((r) => `run:${r.runId}`).slice(0, 10),
    };
  const open = s.escalations.filter((e) => !e.answer);
  if (open.length) {
    const oldest = Math.min(...open.map((e) => Date.parse(e.at)));
    const hours = Math.max(0, Math.round((now.getTime() - oldest) / 3_600_000));
    return {
      text: t.riskAsks(open.length, hours),
      evidence: open.map((e) => `escalation:${e.id}`).slice(0, 10),
    };
  }
  return { text: t.noRisk, evidence: [] };
}

function resultLines(results: readonly ResultLabel[], t: ExecText): ReportLine[] {
  return orNone(
    results.map((x) => ({
      text: `${x.wpId} ${x.status} — ${x.assurance} (${x.basis.slice(0, 200)})`,
      evidence: [`run:${x.runId}`],
    })),
    t.noResults,
  );
}
