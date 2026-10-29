/**
 * The north star (S10, docs/consulting/METRICS-NORTH-STAR.md §1; formulas in
 * docs/metrics/NORTH-STAR.md): Durable Verified Outcomes per week, from the journal only.
 *
 * An intent counts as one DVO, once ever, on the day its first qualifying deliverable
 * landed. Qualifying: accepted (applied or merged), verified (≥ V2 for code, tests and
 * config; ≥ V1 for documents, counted apart as `DVO-doc`) and durable (not rolled back or
 * reverted within 7 days). The count is provisional until 7 days after its week ends.
 */
import type { Assurance } from '@kernelpai/program';
import { verified, type Deliverable, type DeliverableClass } from './deliverables.js';
import type { IntentOrigin } from './intents.js';

export const DURABLE_WINDOW_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export interface DvoItem {
  intent: string;
  origin: IntentOrigin;
  runKey: string;
  /** Journal sequence where its qualifying deliverable landed (audit). */
  seq: number;
  landedAt: string;
  /** ISO week of `landedAt` (UTC), e.g. `2026-W43`. */
  week: string;
  cls: DeliverableClass;
  assurance: Assurance;
  /** Its 7-day durability window has passed with no undoing. */
  durable: boolean;
}

export interface DvoWeek {
  week: string;
  /** Monday 00:00 UTC. */
  start: string;
  dvo: number;
  dvoDoc: number;
  mix: Record<'V1' | 'V2' | 'V3', number>;
  /** 7 days after the week ended: the count can no longer change. */
  final: boolean;
}

export interface DvoCounts {
  /** Code, tests and config outcomes verified ≥ V2. */
  dvo: number;
  /** Documents and other outputs verified ≥ V1, reported apart. */
  dvoDoc: number;
  /** Among them, still inside their 7-day durability window. */
  provisional: number;
  mix: Record<'V1' | 'V2' | 'V3', number>;
  /** V3 ÷ (dvo + dvoDoc): a human opened the evidence (diagnostic, no target). */
  v3Share: number | null;
  weeks: DvoWeek[];
  list: DvoItem[];
}

/** ISO 8601 week of an instant (UTC) and the Monday it starts on. */
export function isoWeek(t: number): { week: string; start: number } {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY_MS;
  const thursday = new Date(start + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const n = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return { week: `${year}-W${String(n).padStart(2, '0')}`, start };
}

/** Undone within the window, or not yet out of it. */
function durability(d: Deliverable, now: number, windowMs: number): 'durable' | 'open' | 'undone' {
  if (d.undone) return 'undone';
  return now - Date.parse(d.landedAt) >= windowMs ? 'durable' : 'open';
}

/**
 * One DVO per intent at most: its first deliverable (journal order) that is accepted,
 * verified and not undone. Splitting the work into more patches or runs of the same
 * intent never adds one.
 */
export function dvoItems(list: readonly Deliverable[], now: number, windowMs: number): DvoItem[] {
  const seen = new Set<string>();
  const out: DvoItem[] = [];
  for (const d of list) {
    if (seen.has(d.intent.key) || !verified(d)) continue;
    const state = durability(d, now, windowMs);
    if (state === 'undone') continue;
    seen.add(d.intent.key);
    out.push({
      intent: d.intent.key,
      origin: d.intent.origin,
      runKey: d.change.runKey,
      seq: d.change.landed?.seq ?? d.change.seq,
      landedAt: d.landedAt,
      week: isoWeek(Date.parse(d.landedAt)).week,
      cls: d.cls,
      assurance: d.assurance,
      durable: state === 'durable',
    });
  }
  return out;
}

const emptyMix = (): Record<'V1' | 'V2' | 'V3', number> => ({ V1: 0, V2: 0, V3: 0 });

function addTo(mix: Record<'V1' | 'V2' | 'V3', number>, a: Assurance): void {
  if (a !== 'V0') mix[a] += 1;
}

/** Weekly counts of the items, oldest week first. */
export function weeksOf(items: readonly DvoItem[], now: number, windowMs: number): DvoWeek[] {
  const weeks = new Map<string, DvoWeek>();
  for (const i of items) {
    const w = isoWeek(Date.parse(i.landedAt));
    let row = weeks.get(w.week);
    if (!row) {
      const final = now >= w.start + 7 * DAY_MS + windowMs;
      row = {
        week: w.week,
        start: new Date(w.start).toISOString(),
        dvo: 0,
        dvoDoc: 0,
        mix: emptyMix(),
        final,
      };
      weeks.set(w.week, row);
    }
    if (i.cls === 'code') row.dvo += 1;
    else row.dvoDoc += 1;
    addTo(row.mix, i.assurance);
  }
  return [...weeks.values()].sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * DVO of the items that landed at or after `from` (each intent was already counted once
 * over the whole journal read, so an intent delivered before the window never re-counts).
 */
export function dvoCounts(
  all: readonly DvoItem[],
  from: number | undefined,
  now: number,
  windowMs: number = DURABLE_WINDOW_MS,
): DvoCounts {
  const list = all.filter((i) => from === undefined || Date.parse(i.landedAt) >= from);
  const mix = emptyMix();
  for (const i of list) addTo(mix, i.assurance);
  const dvo = list.filter((i) => i.cls === 'code').length;
  const total = list.length;
  return {
    dvo,
    dvoDoc: total - dvo,
    provisional: list.filter((i) => !i.durable).length,
    mix,
    v3Share: total > 0 ? Math.round((mix.V3 / total) * 1e4) / 1e4 : null,
    weeks: weeksOf(list, now, windowMs),
    list,
  };
}
