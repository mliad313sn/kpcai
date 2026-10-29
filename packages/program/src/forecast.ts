/**
 * S10 R4(a) forecast: spend at completion and a finish date, each as an interval drawn from
 * the program's own band history (run band tops, settled costs, run durations). Pure.
 *
 * - With five settled runs or more, a remaining run is taken between the 10th and the 90th
 *   percentile of the settled costs (an 80 % interval) and durations.
 * - With fewer, the interval is the whole band seen so far: the cheapest settled cost to
 *   the highest band top (D-021: a run never costs more than its band top). Wide on purpose.
 * - Without any settled run there is no forecast, only the cap.
 * - A live run counts between the low per-run figure and its own band top.
 */
import { ledger } from './ledger.js';
import type { ProgramState, RunRecord } from './schemas.js';

export interface ForecastOptions {
  now: Date;
  /** Runs of this program that may run at once (portfolio `perProgram`). Default 1. */
  concurrency?: number;
  /** Past Sponsor answer delays in hours: added once per gate still to pass. */
  answerHours?: readonly number[];
}

export interface Interval {
  low: number;
  high: number;
}

export interface Forecast {
  spentUsd: number;
  capUsd: number;
  /** Work runs and gate reviews still to start. */
  remainingRuns: number;
  liveRuns: number;
  /** Spend at completion; undefined without history. */
  costUsd?: Interval;
  /** Finish dates (`YYYY-MM-DD`); undefined without history. */
  finish?: { low: string; high: string };
  /** True when the interval is the band range (fewer than five settled runs). */
  wide: boolean;
  /** The settled runs the interval rests on (`run:<id>`). */
  evidence: string[];
  /** Whether the Sponsor's answer time is included in the dates. */
  answersIncluded: boolean;
}

const SAMPLES_FOR_PERCENTILES = 5;
const HOUR = 3_600_000;

/** Linear-interpolated percentile of a non-empty list. */
export function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const at = (s.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

function spread(values: readonly number[], tops: readonly number[]): Interval | undefined {
  if (!values.length) return undefined;
  if (values.length >= SAMPLES_FOR_PERCENTILES)
    return { low: percentile(values, 0.1), high: percentile(values, 0.9) };
  return { low: Math.min(...values), high: Math.max(...values, ...tops) };
}

const settled = (r: RunRecord): boolean => r.status === 'finished' || r.status === 'failed';

/** Work packages and gate reviews not yet started, from the current phase on. */
export function remainingRuns(s: ProgramState): number {
  if (s.status === 'delivered' || s.status === 'stopped') return 0;
  let n = 0;
  s.charter.phases.forEach((p, i) => {
    if (i < s.phaseIndex) return;
    const done = (wpId: string): boolean =>
      s.runs.some((r) => r.wpId === wpId && (r.status === 'finished' || r.status === 'running'));
    n += p.workPackages.filter((wp) => !done(wp.id)).length;
    const passed = s.gates.some((g) => g.phaseId === p.id && g.verdict !== 'hold');
    if (!passed && !done(p.id)) n += 1;
  });
  return n;
}

function gatesLeft(s: ProgramState): number {
  if (s.status === 'delivered' || s.status === 'stopped') return 0;
  return s.charter.phases.filter(
    (p, i) => i >= s.phaseIndex && !s.gates.some((g) => g.phaseId === p.id && g.verdict !== 'hold'),
  ).length;
}

const day = (t: number): string => new Date(t).toISOString().slice(0, 10);

export function forecast(s: ProgramState, o: ForecastOptions): Forecast {
  const l = ledger(s);
  const done = s.runs.filter(settled);
  const live = s.runs.filter((r) => r.status === 'running');
  const remaining = remainingRuns(s);
  const tops = s.runs.map((r) => r.capUsd);
  const perRun = spread(
    done.map((r) => r.costUsd),
    tops,
  );
  const base: Forecast = {
    spentUsd: l.spentUsd,
    capUsd: l.totalCapUsd,
    remainingRuns: remaining,
    liveRuns: live.length,
    wide: done.length < SAMPLES_FOR_PERCENTILES,
    evidence: done.slice(-20).map((r) => `run:${r.runId}`),
    answersIncluded: false,
  };
  if (!perRun) return base;
  const liveLow = live.reduce((a, r) => a + Math.min(perRun.low, r.capUsd), 0);
  const liveHigh = live.reduce((a, r) => a + r.capUsd, 0);
  const costUsd = {
    low: l.spentUsd + liveLow + remaining * perRun.low,
    high: l.spentUsd + liveHigh + remaining * perRun.high,
  };
  return { ...base, costUsd, ...dates(s, o, done, live.length, remaining) };
}

function dates(
  s: ProgramState,
  o: ForecastOptions,
  done: RunRecord[],
  live: number,
  remaining: number,
): Pick<Forecast, 'finish' | 'answersIncluded'> {
  const hours = done
    .filter((r) => r.settledAt)
    .map((r) => Math.max(0, (Date.parse(r.settledAt!) - Date.parse(r.startedAt)) / HOUR));
  const per = spread(hours, []);
  if (!per) return { answersIncluded: false };
  const conc = Math.max(1, Math.floor(o.concurrency ?? 1));
  const waves = Math.ceil(remaining / conc);
  const answers = o.answerHours?.length ? spread(o.answerHours, []) : undefined;
  const gates = gatesLeft(s);
  const low = waves * per.low + gates * (answers?.low ?? 0);
  const high = (waves + (live ? 1 : 0)) * per.high + gates * (answers?.high ?? 0);
  const now = o.now.getTime();
  return {
    finish: { low: day(now + low * HOUR), high: day(now + high * HOUR) },
    answersIncluded: answers !== undefined,
  };
}
