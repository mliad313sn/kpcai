/**
 * Guardrails G3, G5 and G6 of the north star (docs/consulting/METRICS-NORTH-STAR.md §2,
 * formulas in docs/metrics/NORTH-STAR.md), from the journal only. A figure the journal
 * cannot show is `null` with the reason in `notMeasured`: never a guess.
 *
 * - G3 silent failures: runs started with no outcome (and no daemon settlement) past the
 *   stall timeout; watchdog alerts without a report; heartbeat gaps over twice the interval.
 * - G5 safety invariants, each must be 0.
 * - G6 energy per DVO, only from journaled `energyWh` ranges.
 */
import type { JournalEvent } from '@kernelpai/journal';
import { isKernelWrite } from './changes.js';
import { r4, r6, ratio } from './guardrails.js';
import { started, unattended } from './intents.js';
import type { RunRecord } from './runs.js';

const MIN = 60_000;
/** Default stall timeout of a run (`runStallMinutes`) and the grace after it. */
export const RUN_STALL_MS = 30 * MIN;
export const STALL_GRACE_MS = 15 * MIN;
/** A watchdog alert must be followed by a report or notification within this time. */
export const ALERT_FOLLOW_MS = 15 * MIN;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const action = (e: JournalEvent): string | undefined =>
  e.type === 'intervention' ? str(e.payload.action) : undefined;
const FOLLOW_UP = /^(report|notification|notice)\b/i;

export interface SilentGuardrail {
  started: number;
  /** Started, no outcome nor settlement, last event older than the stall timeout + grace. */
  silent: number;
  /** Started, no outcome yet, still inside the timeout. */
  open: number;
  rate: number | null;
  /** Watchdog alerts; `followed` null when nothing reports or notifies in this journal. */
  alerts: { count: number; followed: number | null; unfollowed: number | null };
  heartbeat: { beats: number; gaps: number; longestGapSec: number | null };
}

export interface SilentOptions {
  now: number;
  stallMs?: number;
  graceMs?: number;
}

function silentRuns(
  runs: readonly RunRecord[],
  events: readonly JournalEvent[],
  o: SilentOptions,
): Pick<SilentGuardrail, 'started' | 'silent' | 'open'> {
  const settled = new Set(
    events.filter((e) => action(e) === 'run interrupted').map((e) => str(e.payload.runId)),
  );
  const limit = (o.stallMs ?? RUN_STALL_MS) + (o.graceMs ?? STALL_GRACE_MS);
  let silent = 0;
  let open = 0;
  const begun = runs.filter(started);
  for (const r of begun) {
    if (r.outcome || (r.runId && settled.has(r.runId))) continue;
    const last = Date.parse(r.events.at(-1)?.ts ?? '');
    if (o.now - last > limit) silent += 1;
    else open += 1;
  }
  return { started: begun.length, silent, open };
}

function alertsOf(events: readonly JournalEvent[]): SilentGuardrail['alerts'] {
  const alerts = events.filter((e) => action(e) === 'watchdog alert');
  const follows = events.filter((e) => FOLLOW_UP.test(action(e) ?? ''));
  if (follows.length === 0) return { count: alerts.length, followed: null, unfollowed: null };
  const followed = alerts.filter((a) => {
    const t = Date.parse(a.ts);
    return follows.some((f) => f.seq > a.seq && Date.parse(f.ts) - t <= ALERT_FOLLOW_MS);
  }).length;
  return { count: alerts.length, followed, unfollowed: alerts.length - followed };
}

/** Gaps between consecutive daemon heartbeats longer than twice the journaled interval (J5). */
function heartbeatOf(events: readonly JournalEvent[]): SilentGuardrail['heartbeat'] {
  const beats = events.filter((e) => action(e) === 'enterprise heartbeat');
  let gaps = 0;
  let longest: number | null = null;
  for (const [i, b] of beats.entries()) {
    const prev = beats[i - 1];
    const interval = Number(prev?.payload.intervalSec);
    if (!prev || !(interval > 0)) continue;
    const gap = (Date.parse(b.ts) - Date.parse(prev.ts)) / 1000;
    longest = Math.max(longest ?? 0, gap);
    if (gap > 2 * interval) gaps += 1;
  }
  return { beats: beats.length, gaps, longestGapSec: longest === null ? null : r4(longest) };
}

/** G3 over the runs and events of the window. */
export function silentGuardrail(
  runs: readonly RunRecord[],
  events: readonly JournalEvent[],
  o: SilentOptions,
): SilentGuardrail {
  const r = silentRuns(runs, events, o);
  return {
    ...r,
    rate: ratio(r.silent, r.started),
    alerts: alertsOf(events),
    heartbeat: heartbeatOf(events),
  };
}

export interface SafetyGuardrail {
  /** Kernel writes and merges with no checkpoint before them (R-305). */
  writesWithoutCheckpoint: number;
  /** Unattended runs that used a subscription source (D-029 R1). */
  unattendedSubscription: number;
  /** Spend questions pre-answered by an envelope without a known amount (D-028). */
  preAnsweredWithoutAmount: number;
  /** `kpai verify`: 1 when the hash chain is broken, null when not checked. */
  journalBroken: number | null;
  /** Sum of the measured counts: must be 0. */
  total: number;
  ok: boolean;
}

const OK_DECISIONS = new Set(['allow', 'confirmed']);

/** Each applied kernel write needs a checkpoint journaled in its session since the last write. */
function uncheckpointed(events: readonly JournalEvent[]): number {
  const armed = new Map<string, boolean>();
  let missing = 0;
  for (const e of events) {
    const a = action(e);
    if (a === 'checkpoint') armed.set(e.sessionId, true);
    else if (a === 'merge-back' && !str(e.payload.checkpoint)) missing += 1;
    else if (isKernelWrite(e) && OK_DECISIONS.has(str(e.payload.decision) ?? '')) {
      if (e.payload.isError !== true && armed.get(e.sessionId) !== true) missing += 1;
      armed.set(e.sessionId, false);
    }
  }
  return missing;
}

function subscriptionRuns(runs: readonly RunRecord[]): number {
  return runs.filter(
    (r) =>
      unattended(r) &&
      (r.outcome?.sources?.includes('subscription') === true ||
        r.events.some((e) => action(e) === 'agent run')),
  ).length;
}

/** G5: every count must be 0. `verified` is the result of `Journal.verify()`, if run. */
export function safetyGuardrail(
  runs: readonly RunRecord[],
  events: readonly JournalEvent[],
  verified: { ok: boolean } | undefined,
): SafetyGuardrail {
  const preAnswered = events.filter(
    (e) =>
      action(e) === 'pre-answered' &&
      e.payload.kind === 'budget' &&
      !Number.isFinite(Number(e.payload.amountUsd ?? Number.NaN)),
  ).length;
  const counts = {
    writesWithoutCheckpoint: uncheckpointed(events),
    unattendedSubscription: subscriptionRuns(runs),
    preAnsweredWithoutAmount: preAnswered,
    journalBroken: verified ? (verified.ok ? 0 : 1) : null,
  };
  const total = Object.values(counts).reduce<number>((a, x) => a + (x ?? 0), 0);
  return { ...counts, total, ok: total === 0 };
}

export interface EnergyGuardrail {
  /** False: no response journaled an `energyWh` range (J4): not measured, never guessed. */
  measured: boolean;
  responses: number;
  energyWh: [number, number] | null;
  perDvoWh: [number, number] | null;
}

/** G6: Σ of journaled `energyWh: [low, high]` on responses, per outcome. */
export function energyGuardrail(
  events: readonly JournalEvent[],
  outcomes: number,
): EnergyGuardrail {
  let low = 0;
  let high = 0;
  let n = 0;
  for (const e of events) {
    const w = e.type === 'response' ? e.payload.energyWh : undefined;
    if (!Array.isArray(w) || w.length !== 2) continue;
    const [a, b] = w.map(Number) as [number, number];
    if (!(a >= 0 && b >= a)) continue;
    low += a;
    high += b;
    n += 1;
  }
  if (n === 0) return { measured: false, responses: 0, energyWh: null, perDvoWh: null };
  const per = outcomes > 0 ? ([r6(low / outcomes), r6(high / outcomes)] as [number, number]) : null;
  return { measured: true, responses: n, energyWh: [r6(low), r6(high)], perDvoWh: per };
}
