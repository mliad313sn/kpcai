/**
 * Derived views of the Enterprise state, pure so the web view and the TUI share them:
 * heartbeat liveness (R2: silence never looks healthy), the portfolio spend gauge with its
 * band-top reservation (D-021), seat ordering and grouping, and the inbox split (R8).
 */
import type { EntState } from './state';
import {
  ASSURANCE_LABELS,
  type Assurance,
  type Gauge,
  type Heartbeat,
  type InboxItem,
  type ResultEntry,
  type SeatState,
  type SeatView,
} from './schemas';

export type Liveness = 'ok' | 'late' | 'alert' | 'stale' | 'unknown' | 'offline';

export interface HeartbeatStatus {
  level: Liveness;
  /** Age of the last heartbeat in ms (undefined when none was ever received). */
  ageMs?: number;
  /** Watchdog alerts the daemon raised (S10 R2), daemon-built text. */
  alerts: Heartbeat['alerts'];
}

/**
 * `ok` within 1.5 intervals, `late` up to the daemon's `staleAfterSec`, `stale` beyond (or
 * when the daemon says so); `alert` when the watchdog raised something. No heartbeat is
 * `unknown` and a dropped connection is `offline`. Only `ok` is shown as healthy.
 */
export function heartbeatStatus(
  hb: Heartbeat | undefined,
  now: number,
  connected: boolean,
): HeartbeatStatus {
  const at = hb ? Date.parse(hb.at) : NaN;
  const ageMs = Number.isFinite(at) ? Math.max(0, now - at) : undefined;
  const base = { alerts: hb?.alerts ?? [], ...(ageMs === undefined ? {} : { ageMs }) };
  if (!connected) return { level: 'offline', ...base };
  if (!hb || ageMs === undefined) return { level: 'unknown', ...base };
  if (hb.status === 'stale' || ageMs > hb.staleAfterSec * 1000) return { level: 'stale', ...base };
  if (hb.status === 'alert' || hb.alerts.length > 0) return { level: 'alert', ...base };
  const level = ageMs <= hb.intervalSec * 1500 ? 'ok' : 'late';
  return { level, ...base };
}

export const isHealthy = (s: HeartbeatStatus): boolean => s.level === 'ok';

export interface SpendGauge {
  spent: number;
  /** Spent plus the band tops of live runs (D-021). */
  committed: number;
  cap: number;
  /** committed − spent: money reserved for runs still going. */
  reserved: number;
  /** committed / cap, clamped to [0, 1.5] for drawing. */
  ratio: number;
  over: boolean;
  rate?: { usdPerHour: number; capUsdPerHour?: number };
  concurrency?: { inUse: number; limit: number };
}

/** The portfolio gauge, or the sum of the program gauges when the kernel sends none. */
export function portfolioSpend(gauges: readonly Gauge[]): SpendGauge | undefined {
  const own = gauges.find((g) => g.scope === 'portfolio' && g.usd);
  const parts = own ? [own] : gauges.filter((g) => g.scope === 'program' && g.usd);
  if (parts.length === 0) return undefined;
  const sum = (f: (g: Gauge) => number) => parts.reduce((a, g) => a + f(g), 0);
  const spent = sum((g) => g.usd!.spent);
  const committed = Math.max(
    spent,
    sum((g) => g.usd!.committed),
  );
  const cap = sum((g) => g.usd!.cap);
  const ratio = cap > 0 ? Math.min(1.5, committed / cap) : committed > 0 ? 1.5 : 0;
  // The daemon sends the last hour's spend and the $/hour cap (S10 R3).
  const r = own?.rate ?? gauges.find((g) => g.scope === 'portfolio')?.rate;
  const rateOf = r ? { usdPerHour: r.usdLastHour, capUsdPerHour: r.usdPerHour } : undefined;
  const conc = own?.concurrency ?? gauges.find((g) => g.scope === 'portfolio')?.concurrency;
  return {
    spent,
    committed,
    cap,
    reserved: Math.max(0, committed - spent),
    ratio,
    over: cap > 0 && committed > cap,
    ...(rateOf ? { rate: rateOf } : {}),
    ...(conc ? { concurrency: conc } : {}),
  };
}

/** Subscription quotas and local compute, one row per source gauge that has them. */
export function quotaGauges(gauges: readonly Gauge[]): Gauge[] {
  return gauges.filter((g) => g.scope === 'source' && (g.quota || g.localHours !== undefined));
}

export function rateOver(g: SpendGauge): boolean {
  const cap = g.rate?.capUsdPerHour;
  return cap !== undefined && g.rate!.usdPerHour > cap;
}

/** What needs a human first: waiting for you, blocked, then working, then idle. */
export const SEAT_ORDER: Record<SeatState, number> = {
  waiting_for_you: 0,
  blocked: 1,
  writing: 2,
  thinking: 3,
  reviewing: 4,
  idle: 5,
};

export const WORKING: ReadonlySet<SeatState> = new Set(['writing', 'thinking', 'reviewing']);

export function sortSeats(seats: readonly SeatView[]): SeatView[] {
  return [...seats].sort(
    (a, b) =>
      SEAT_ORDER[a.state] - SEAT_ORDER[b.state] ||
      a.department.localeCompare(b.department) ||
      a.title.localeCompare(b.title) ||
      a.seatId.localeCompare(b.seatId),
  );
}

export type SeatFilter = 'all' | 'attention' | 'working' | 'idle';

export function matchesFilter(seat: SeatView, f: SeatFilter): boolean {
  if (f === 'attention') return seat.state === 'waiting_for_you' || seat.state === 'blocked';
  if (f === 'working') return WORKING.has(seat.state);
  if (f === 'idle') return seat.state === 'idle';
  return true;
}

export interface SeatCounts {
  total: number;
  working: number;
  waiting: number;
  blocked: number;
  idle: number;
}

export function seatCounts(seats: readonly SeatView[]): SeatCounts {
  const c: SeatCounts = { total: seats.length, working: 0, waiting: 0, blocked: 0, idle: 0 };
  for (const s of seats) {
    if (s.state === 'waiting_for_you') c.waiting++;
    else if (s.state === 'blocked') c.blocked++;
    else if (s.state === 'idle') c.idle++;
    else c.working++;
  }
  return c;
}

/** A row of the org map: a department heading (expert view) or up to `perRow` seats. */
export type OrgRow =
  | { kind: 'head'; key: string; department: string; counts: SeatCounts }
  | { kind: 'seats'; key: string; seats: SeatView[] };

function chunk(key: string, seats: SeatView[], perRow: number): OrgRow[] {
  const rows: OrgRow[] = [];
  for (let i = 0; i < seats.length; i += perRow)
    rows.push({ kind: 'seats', key: `${key}#${i}`, seats: seats.slice(i, i + perRow) });
  return rows;
}

/**
 * Team view (the default, R7): one team, most urgent first. Departments view (expert):
 * one heading per department, then its seats.
 */
export function orgRows(
  seats: readonly SeatView[],
  mode: 'team' | 'departments',
  perRow: number,
): OrgRow[] {
  const n = Math.max(1, Math.floor(perRow));
  const sorted = sortSeats(seats);
  if (mode === 'team') return chunk('team', sorted, n);
  const groups = new Map<string, SeatView[]>();
  for (const s of sorted) groups.set(s.department, [...(groups.get(s.department) ?? []), s]);
  const rows: OrgRow[] = [];
  for (const dept of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const list = groups.get(dept)!;
    rows.push({ kind: 'head', key: `h:${dept}`, department: dept, counts: seatCounts(list) });
    rows.push(...chunk(`d:${dept}`, list, n));
  }
  return rows;
}

/** R8: only items the kernel marks `trivial` may be batched; unmarked is consequential. */
export function splitInbox(items: readonly InboxItem[]): {
  consequential: InboxItem[];
  trivial: InboxItem[];
} {
  const trivial = items.filter((i) => i.class === 'trivial');
  return { consequential: items.filter((i) => i.class !== 'trivial'), trivial };
}

/** Delivered results per assurance label, as proportions; undefined before the first one. */
export function assuranceShares(
  results: readonly ResultEntry[],
): Array<{ label: Assurance; count: number; share: number }> | undefined {
  if (results.length === 0) return undefined;
  return ASSURANCE_LABELS.map((label) => {
    const count = results.filter((r) => r.assurance === label).length;
    return { label, count, share: count / results.length };
  });
}

/** One sentence for the polite live region: counts, never per-seat chatter (R12). */
export function summaryCounts(s: EntState): {
  programs: number;
  seats: SeatCounts;
  asks: number;
} {
  return { programs: s.programs.length, seats: seatCounts(s.seats), asks: s.inbox.length };
}

export const LIVE_PROGRAM: ReadonlySet<string> = new Set(['approved', 'running', 'gate']);
export const PAUSED_PROGRAM: ReadonlySet<string> = new Set(['paused']);
export const ENDED_PROGRAM: ReadonlySet<string> = new Set(['stopped', 'delivered']);
