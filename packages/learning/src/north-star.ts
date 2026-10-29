/**
 * The north star and its six guardrails (S10; docs/consulting/METRICS-NORTH-STAR.md),
 * computed from the journal only. Formulas, thresholds and what is not measured:
 * docs/metrics/NORTH-STAR.md. Humans read these numbers; no planner, router or assistant
 * is ever given them as an objective (Campbell's law).
 */
import type { Journal, JournalEvent } from '@kernelpai/journal';
import { deliverablesOf, hasImages, type Deliverable } from './deliverables.js';
import { DURABLE_WINDOW_MS, dvoCounts, dvoItems, type DvoCounts } from './dvo.js';
import {
  attentionGuardrail,
  costGuardrail,
  escapeGuardrail,
  type AttentionGuardrail,
  type CostGuardrail,
  type EscapeGuardrail,
} from './guardrails.js';
import {
  energyGuardrail,
  safetyGuardrail,
  silentGuardrail,
  type EnergyGuardrail,
  type SafetyGuardrail,
  type SilentGuardrail,
} from './guardrails-live.js';
import { readRuns, type ReadOptions } from './grades.js';
import { intentsOf, started } from './intents.js';
import { productivityOf } from './productivity.js';
import type { JournalRuns, RunRecord } from './runs.js';

export interface NorthStarOptions extends ReadOptions {
  /** The workspace (session working directory). */
  project: string;
  /** Window start (ISO 8601 or a Date); default: everything read. */
  since?: string | Date;
  /** The instant the report is made (tests pin it); default now. */
  now?: Date;
  /** Durability window; default 7 days. */
  durableWindowMs?: number;
  /** Run `Journal.verify()` for G5 (default true with `northStar`). */
  verify?: boolean;
}

export interface Guardrails {
  g1Cost: CostGuardrail;
  g2Attention: AttentionGuardrail;
  g3Silent: SilentGuardrail;
  g4Escape: EscapeGuardrail;
  g5Safety: SafetyGuardrail;
  g6Energy: EnergyGuardrail;
}

export interface NorthStarReport extends DvoCounts {
  project: string;
  since: string | null;
  now: string;
  /** `rollback-only` until a kernel write in this project journaled J3 images. */
  durability: 'rollback and revert' | 'rollback-only';
  /** Human intents served by runs started in the window (fact-only segments never count). */
  intents: number;
  guardrails: Guardrails;
  /** Guardrails over their initial threshold (METRICS-NORTH-STAR §2), e.g. `G2 rubber-stamp`. */
  breached: string[];
  /** What the journal cannot show yet, said rather than guessed. */
  notMeasured: string[];
  /** Accepted deliverables of the window, for audit. */
  deliverables: Deliverable[];
}

function sinceMs(since: string | Date | undefined): number | undefined {
  if (since === undefined) return undefined;
  const t = since instanceof Date ? since.getTime() : Date.parse(since);
  if (!Number.isFinite(t)) throw new RangeError(`since is not a date: ${String(since)}`);
  return t;
}

const startOf = (r: RunRecord): number => Date.parse(r.events[0]?.ts ?? '');

function breaches(g: Guardrails): string[] {
  const out: string[] = [];
  if (g.g1Cost.band.rate !== null && g.g1Cost.band.rate < 0.8) out.push('G1 band');
  if (g.g1Cost.capToLikelyMedian !== null && g.g1Cost.capToLikelyMedian > 3) out.push('G1 cap');
  if (g.g2Attention.rubberStamp.rate !== null && g.g2Attention.rubberStamp.rate >= 0.1)
    out.push('G2 rubber-stamp');
  if (g.g3Silent.rate !== null && g.g3Silent.rate >= 0.01) out.push('G3 silent runs');
  if ((g.g3Silent.alerts.unfollowed ?? 0) > 0) out.push('G3 alerts');
  if (g.g3Silent.heartbeat.gaps > 0) out.push('G3 heartbeat');
  const v2 = g.g4Escape.byAssurance.V2.rate;
  if (v2 !== null && v2 >= 0.1) out.push('G4 escape');
  if (!g.g5Safety.ok) out.push('G5 safety');
  return out;
}

function notMeasured(g: Guardrails, durability: NorthStarReport['durability']): string[] {
  const out = [
    'G1 cost-per-DVO trend: needs 4 weeks of baseline',
    'G3 delivered-but-unverified programs: not journaled (program store, report.ts)',
    'G5 zone content sent to a cloud provider: refused before the call, never journaled',
    'G5 envelope allow outside caps: re-checked in the program store, not the journal',
    'G5 scope or physical packs in unattended runs (R13): pack effects are not journaled',
  ];
  if (durability === 'rollback-only') out.push('G4 reverts: no J3 file hashes in this journal');
  if (g.g3Silent.alerts.followed === null)
    out.push('G3 alert follow-up: no report or notification journaled');
  if (!g.g6Energy.measured) out.push('G6 energy: no energyWh journaled (J4)');
  return out;
}

/** North star and guardrails of the given runs (pure; `verified` from `Journal.verify`). */
export function northStarOf(
  all: JournalRuns,
  o: Omit<NorthStarOptions, 'limit' | 'verify'>,
  verified?: { ok: boolean },
): NorthStarReport {
  const from = sinceMs(o.since);
  const now = (o.now ?? new Date()).getTime();
  const windowMs = o.durableWindowMs ?? DURABLE_WINDOW_MS;
  const project = all.runs.filter((r) => r.project === o.project && r.events.length > 0);
  const events: JournalEvent[] = project
    .flatMap((r) => [...r.events, ...r.after])
    .sort((a, b) => a.seq - b.seq);
  const inWindow = (t: number): boolean => from === undefined || t >= from;
  const runs = project.filter((r) => inWindow(startOf(r)));
  const deliverables = deliverablesOf(all, project, events, windowMs);
  const counts = dvoCounts(dvoItems(deliverables, now, windowMs), from, now, windowMs);
  const outcomes = counts.dvo + counts.dvoDoc;
  const prod = productivityOf(all, { project: o.project, ...(o.since ? { since: o.since } : {}) });
  const windowEvents = events.filter((e) => inWindow(Date.parse(e.ts)));
  const landed = deliverables.filter((d) => inWindow(Date.parse(d.landedAt)));
  const guardrails: Guardrails = {
    g1Cost: costGuardrail(prod.spentUsd, outcomes, prod.band, runs),
    g2Attention: attentionGuardrail(events, from, outcomes),
    g3Silent: silentGuardrail(runs, windowEvents, { now }),
    g4Escape: escapeGuardrail(landed),
    g5Safety: safetyGuardrail(runs, windowEvents, verified),
    g6Energy: energyGuardrail(windowEvents, outcomes),
  };
  const durability = hasImages(events) ? 'rollback and revert' : 'rollback-only';
  const intents = intentsOf(all);
  return {
    project: o.project,
    since: from === undefined ? null : new Date(from).toISOString(),
    now: new Date(now).toISOString(),
    durability,
    intents: new Set(runs.filter(started).map((r) => intents.get(r.key)?.key)).size,
    ...counts,
    guardrails,
    breached: breaches(guardrails),
    notMeasured: notMeasured(guardrails, durability),
    deliverables: landed,
  };
}

/** The north star read from the journal now (`kpai stats --north-star`, `stats.northStar`). */
export function northStar(journal: Journal, o: NorthStarOptions): NorthStarReport {
  const verified = o.verify === false ? undefined : journal.verify();
  return northStarOf(readRuns(journal, o), o, verified);
}
