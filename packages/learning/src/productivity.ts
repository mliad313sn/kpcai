/**
 * Honest productivity metrics (R-406), computed from the journal only: no self-reported
 * figure, no vendor number. Formulas: docs/metrics/PRODUCTIVITY.md.
 *
 * - cost and time per accepted change: everything spent in the window (failed, cancelled
 *   and abandoned runs included) divided by the changes that reached the workspace;
 * - rollback rate: accepted changes undone by a checkpoint restore ÷ accepted changes;
 * - rework rate: accepted changes rolled back, or touched again by a later run within the
 *   rework window ÷ accepted changes;
 * - defects caught by review: accepted findings (R-404) recomputed from the run records;
 * - band hit rate: finished runs whose billed cost fell inside the approved band (R-402).
 */
import type { ProtocolResult } from '@kernelpai/core';
import type { Journal, JournalEvent } from '@kernelpai/journal';
import { NODE_RECORDED, nodeVerification } from '@kernelpai/orchestrator';
import { accuracyOf } from './accuracy.js';
import {
  markRework,
  markRollbacks,
  runChanges,
  type Change,
  type ChangeStatus,
} from './changes.js';
import { readRuns, type ReadOptions } from './grades.js';
import type { JournalRuns, RunRecord } from './runs.js';

/** Default rework window: a file changed again by another run within 7 days. */
export const REWORK_WINDOW_MS = 7 * 24 * 3600 * 1000;

export interface ProductivityOptions extends ReadOptions {
  /** The workspace (session working directory) the metrics are about. */
  project: string;
  /** Only runs that started at or after this instant (ISO 8601 or a Date). */
  since?: string | Date;
  reworkWindowMs?: number;
}

export interface ReviewYield {
  /** Nodes with a run record in the window (reused fork nodes left out). */
  nodes: number;
  reviewUsd: number;
  issuesRaised: number;
  /** Issues of rejecting verdicts answered by a revision the reviewers then approved. */
  acceptedFindings: number;
  acceptedRevisions: number;
  usdPerAcceptedFinding: number | null;
}

export interface ProductivityReport {
  project: string;
  since: string | null;
  /** Runs (and unnamed segments such as `kpai ask`) that started in the window. */
  runs: number;
  spentUsd: number;
  /** Σ wall time of those runs, first to last journaled event. */
  runTimeMs: number;
  changes: Record<ChangeStatus, number>;
  /** Runs with at least one accepted change. */
  runsWithAcceptedChange: number;
  costPerAcceptedChangeUsd: number | null;
  timePerAcceptedChangeMs: number | null;
  rolledBack: number;
  rollbackRate: number | null;
  reworked: number;
  reworkRate: number | null;
  reworkWindowMs: number;
  review: ReviewYield;
  /** Finished, uncancelled runs with a journaled plan, against their approved band. */
  band: { runs: number; inBand: number; rate: number | null };
  /** Workspace restores whose checkpoint was not in the journal read. */
  unattributedRestores: number;
  /** Every change counted, for audit: each one names its run, node and journal sequence. */
  list: Change[];
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6 || 0;
const ratio = (a: number, b: number, round = r4): number | null => (b > 0 ? round(a / b) : null);

function sinceMs(since: string | Date | undefined): number | undefined {
  if (since === undefined) return undefined;
  const t = since instanceof Date ? since.getTime() : Date.parse(since);
  if (!Number.isFinite(t)) throw new RangeError(`since is not a date: ${String(since)}`);
  return t;
}

const startOf = (r: RunRecord): number => Date.parse(r.events[0]?.ts ?? '');

function wallTime(r: RunRecord): number {
  const t0 = startOf(r);
  const t1 = Date.parse(r.events.at(-1)?.ts ?? '');
  return Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, t1 - t0) : 0;
}

const spend = (r: RunRecord): number =>
  r.events.reduce((a, e) => a + (e.costUsd !== null && e.costUsd > 0 ? e.costUsd : 0), 0);

/** A journaled protocol result, checked enough for `nodeVerification` (journal is data). */
function recordedResult(e: JournalEvent): ProtocolResult | undefined {
  if (e.type !== 'intervention' || e.payload.action !== NODE_RECORDED) return undefined;
  if (e.payload.reused === true) return undefined;
  const r = e.payload.result as Partial<ProtocolResult> | undefined;
  if (!r || typeof r !== 'object' || !Array.isArray(r.contributions)) return undefined;
  const contributions = r.contributions.filter(
    (c) =>
      typeof c === 'object' &&
      c !== null &&
      typeof c.role === 'string' &&
      (c.verdict === undefined || Array.isArray(c.verdict?.issues)),
  );
  return {
    nodeId: String(r.nodeId ?? e.nodeId ?? ''),
    protocol: r.protocol ?? 'solo',
    output: '',
    costUsd: typeof r.costUsd === 'number' ? r.costUsd : 0,
    ok: r.ok === true,
    ...(typeof r.approved === 'boolean' ? { approved: r.approved } : {}),
    contributions: contributions.map((c) => ({
      ...c,
      costUsd: typeof c.costUsd === 'number' ? c.costUsd : 0,
    })),
  };
}

function reviewYield(runs: readonly RunRecord[]): ReviewYield {
  const y = { nodes: 0, reviewUsd: 0, issuesRaised: 0, acceptedFindings: 0, acceptedRevisions: 0 };
  for (const e of runs.flatMap((r) => r.events)) {
    const res = recordedResult(e);
    if (!res) continue;
    const v = nodeVerification(res);
    y.nodes += 1;
    y.reviewUsd += v.reviewUsd;
    y.issuesRaised += v.issuesRaised;
    y.acceptedFindings += v.acceptedFindings;
    y.acceptedRevisions += v.acceptedRevisions;
  }
  return {
    ...y,
    reviewUsd: r6(y.reviewUsd),
    usdPerAcceptedFinding: ratio(y.reviewUsd, y.acceptedFindings, r6),
  };
}

function counts(list: readonly Change[]): Record<ChangeStatus, number> {
  const c: Record<ChangeStatus, number> = {
    accepted: 0,
    declined: 0,
    failed: 0,
    pending: 0,
    discarded: 0,
  };
  for (const x of list) c[x.status] += 1;
  return c;
}

/** Productivity of the given runs for one project (pure). */
export function productivityOf(
  all: JournalRuns,
  o: Omit<ProductivityOptions, 'limit'>,
): ProductivityReport {
  const from = sinceMs(o.since);
  const windowMs = o.reworkWindowMs ?? REWORK_WINDOW_MS;
  const project = all.runs.filter((r) => r.project === o.project && r.events.length > 0);
  const runs = project.filter((r) => from === undefined || startOf(r) >= from);
  const list = runs.flatMap(runChanges);
  const scan = markRollbacks(
    list,
    project.flatMap((r) => [...r.events, ...r.after]),
  );
  markRework(list, windowMs);
  const accepted = list.filter((c) => c.status === 'accepted');
  const spentUsd = r6(runs.reduce((a, r) => a + spend(r), 0));
  const runTimeMs = runs.reduce((a, r) => a + wallTime(r), 0);
  const rolledBack = accepted.filter((c) => c.rolledBackSeq !== undefined).length;
  const reworked = accepted.filter(
    (c) => c.rolledBackSeq !== undefined || c.reworkedSeq !== undefined,
  ).length;
  const band = accuracyOf({ ...all, runs }, { project: o.project }).runs;
  return {
    project: o.project,
    since: from === undefined ? null : new Date(from).toISOString(),
    runs: runs.length,
    spentUsd,
    runTimeMs,
    changes: counts(list),
    runsWithAcceptedChange: new Set(accepted.map((c) => c.runKey)).size,
    costPerAcceptedChangeUsd: ratio(spentUsd, accepted.length, r6),
    timePerAcceptedChangeMs: ratio(runTimeMs, accepted.length, Math.round),
    rolledBack,
    rollbackRate: ratio(rolledBack, accepted.length),
    reworked,
    reworkRate: ratio(reworked, accepted.length),
    reworkWindowMs: windowMs,
    review: reviewYield(runs),
    band: { runs: band.samples, inBand: band.inBand, rate: band.inBandRate },
    unattributedRestores: scan.unattributed,
    list,
  };
}

/** Productivity read from the journal now (`kpai stats --productivity`, `stats.productivity`). */
export function productivity(journal: Journal, o: ProductivityOptions): ProductivityReport {
  return productivityOf(readRuns(journal, o), o);
}
