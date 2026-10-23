/**
 * Published estimate accuracy (R-402, ADR-0028): for every finished, uncancelled run whose
 * plan was journaled, the estimate the user approved against the cost the journal billed,
 * per task type (node level) and for whole runs, with the share inside the band, split by
 * band basis: cold start (heuristic), calibrated, or mixed. Journal only.
 */
import type { Journal } from '@kernelpai/journal';
import { readRuns, type ReadOptions } from './grades.js';
import type { JournalRuns, RunRecord } from './runs.js';

export type Basis = 'cold-start' | 'calibrated' | 'mixed';

export interface AccuracyRow {
  /** Task type, basis or `run`. */
  label: string;
  samples: number;
  meanEstimateUsd: number;
  meanActualUsd: number;
  /** mean(|estimate − actual| ÷ actual) × 100 over samples with a cost; null without. */
  meanAbsErrorPct: number | null;
  /** mean((estimate − actual) ÷ actual) × 100; positive = over-estimated. */
  meanSignedErrorPct: number | null;
  inBand: number;
  below: number;
  above: number;
  /** inBand ÷ samples; null without samples. */
  inBandRate: number | null;
}

export interface AccuracyReport {
  /** Whole runs: plan total against the run's billed cost. */
  runs: AccuracyRow;
  byTaskType: AccuracyRow[];
  /** Nodes by band basis: cold start against calibrated (R-402). */
  byBasis: AccuracyRow[];
  /** Runs left out, and why: an estimate is only compared with a complete run. */
  excluded: { cancelled: number; notFinished: number; noPlan: number };
}

export interface AccuracyOptions extends ReadOptions {
  project?: string;
}

interface Sample {
  label: string;
  basis: Basis;
  estimate: number;
  low: number;
  high: number;
  actual: number;
}

interface Band {
  lowUsd?: unknown;
  highUsd?: unknown;
  basis?: unknown;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6 || 0;
const EPS = 1e-9;

const basisOf = (b: unknown): Basis =>
  b === 'calibrated' ? 'calibrated' : b === 'heuristic' ? 'cold-start' : 'mixed';

function sample(label: string, est: unknown, band: Band | undefined, actual: number) {
  const estimate = num(est);
  const low = num(band?.lowUsd);
  const high = num(band?.highUsd);
  if (estimate === undefined || low === undefined || high === undefined) return undefined;
  return { label, basis: basisOf(band?.basis), estimate, low, high, actual: r6(actual) };
}

function costs(run: RunRecord): { total: number; byNode: Map<string, number> } {
  const byNode = new Map<string, number>();
  let total = 0;
  for (const e of run.events) {
    const c = e.costUsd ?? 0;
    if (!(c > 0)) continue;
    total += c;
    if (e.nodeId) byNode.set(e.nodeId, (byNode.get(e.nodeId) ?? 0) + c);
  }
  return { total, byNode };
}

/** Samples of one run: the run itself, then each planned node. */
function samplesOf(run: RunRecord): Sample[] {
  const payload = run.plan?.payload ?? {};
  const est = (payload.estimate ?? {}) as Record<string, unknown>;
  const graph = (payload.plan ?? {}) as { nodes?: Array<{ id?: unknown; type?: unknown }> };
  const types = new Map((graph.nodes ?? []).map((n) => [String(n.id), String(n.type)]));
  const { total, byNode } = costs(run);
  const out: Sample[] = [];
  const whole = sample('run', est.expectedUsd ?? est.totalUsd, est.band as Band, total);
  if (whole) out.push(whole);
  const nodes = Array.isArray(est.nodes) ? (est.nodes as Array<Record<string, unknown>>) : [];
  for (const n of nodes) {
    const id = String(n.nodeId);
    const type = types.get(id);
    if (!type || n.error !== undefined) continue;
    const s = sample(type, n.expectedUsd, n.band as Band, byNode.get(id) ?? 0);
    if (s) out.push(s);
  }
  return out;
}

function row(label: string, xs: readonly Sample[]): AccuracyRow {
  const n = xs.length;
  const mean = (f: (s: Sample) => number): number => (n ? xs.reduce((a, s) => a + f(s), 0) / n : 0);
  const priced = xs.filter((s) => s.actual > 0);
  const err = (f: (d: number) => number): number | null =>
    priced.length
      ? r4(
          (priced.reduce((a, s) => a + f((s.estimate - s.actual) / s.actual), 0) / priced.length) *
            100,
        )
      : null;
  const below = xs.filter((s) => s.actual < s.low - EPS).length;
  const above = xs.filter((s) => s.actual > s.high + EPS).length;
  const inBand = n - below - above;
  return {
    label,
    samples: n,
    meanEstimateUsd: r6(mean((s) => s.estimate)),
    meanActualUsd: r6(mean((s) => s.actual)),
    meanAbsErrorPct: err(Math.abs),
    meanSignedErrorPct: err((d) => d),
    inBand,
    below,
    above,
    inBandRate: n ? r4(inBand / n) : null,
  };
}

function grouped(xs: readonly Sample[], by: (s: Sample) => string): AccuracyRow[] {
  const groups = new Map<string, Sample[]>();
  for (const s of xs) groups.set(by(s), [...(groups.get(by(s)) ?? []), s]);
  return [...groups.entries()]
    .map(([label, list]) => row(label, list))
    .sort((a, b) => b.samples - a.samples || a.label.localeCompare(b.label));
}

/** Estimate accuracy of the given runs. */
export function accuracyOf(runs: JournalRuns, options: { project?: string } = {}): AccuracyReport {
  const excluded = { cancelled: 0, notFinished: 0, noPlan: 0 };
  const all: Sample[] = [];
  for (const run of runs.runs) {
    if (options.project !== undefined && run.project !== options.project) continue;
    if (!run.plan) {
      if (run.outcome) excluded.noPlan += 1;
      continue;
    }
    if (run.cancelled) excluded.cancelled += 1;
    else if (run.outcome?.status !== 'finished') excluded.notFinished += 1;
    else all.push(...samplesOf(run));
  }
  const whole = all.filter((s) => s.label === 'run');
  const nodes = all.filter((s) => s.label !== 'run');
  return {
    runs: row('run', whole),
    byTaskType: grouped(nodes, (s) => s.label),
    byBasis: grouped(nodes, (s) => s.basis),
    excluded,
  };
}

/** Estimate accuracy read from the journal now (`kpai stats`, the UI's accuracy view). */
export function estimateAccuracy(journal: Journal, options: AccuracyOptions = {}): AccuracyReport {
  return accuracyOf(readRuns(journal, options), options);
}

const pct = (x: number | null): string => (x === null ? '–' : `${Math.round(x * 100)} %`);

/**
 * One line shown before launch next to an estimate (R-402), e.g.
 * "past estimates here: 18/20 runs inside the band (90 %); test: 7/8 (cold start 2/4)".
 */
export function accuracyNote(report: AccuracyReport, taskTypes: readonly string[] = []): string {
  const r = report.runs;
  if (r.samples === 0) return 'past estimates here: no finished run yet (cold start)';
  const parts = [
    `past estimates here: ${r.inBand}/${r.samples} runs inside the band (${pct(r.inBandRate)})`,
  ];
  for (const t of new Set(taskTypes)) {
    const x = report.byTaskType.find((row) => row.label === t);
    if (x) parts.push(`${t}: ${x.inBand}/${x.samples}`);
  }
  const cold = report.byBasis.find((b) => b.label === 'cold-start');
  if (cold) parts.push(`cold start ${cold.inBand}/${cold.samples}`);
  return parts.join('; ');
}
