/**
 * The unit of the north star (docs/metrics/NORTH-STAR.md, S10 R6 J1): the human intent a
 * run serves, read from the journal only.
 *
 * - A `run intent` intervention names it: `human-request` (a person typed the request, or
 *   ran a ticket) or `charter-wp:<hash>` (a work package of a charter the Sponsor approved).
 * - A fork serves its parent's intent (`run started` names the parent run).
 * - A run journaled before J1 serves its own run id (the documented proxy).
 *
 * So retries, fallbacks, forks and every patch of one request stay one intent: splitting
 * the work never adds intents (Goodhart).
 */
import type { JournalEvent } from '@kernelpai/journal';
import type { JournalRuns, RunRecord } from './runs.js';

export const INTENT_ACTIONS = {
  intent: 'run intent',
  started: 'run started',
} as const;

export type IntentOrigin = 'human-request' | 'charter-wp' | 'proxy';

export interface Intent {
  /** Stable key: origin and id (an amended charter has another hash: another intent). */
  key: string;
  id: string;
  origin: IntentOrigin;
}

/** Forks of forks are followed this deep, then the run counts as its own intent. */
const MAX_FORK_DEPTH = 32;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const action = (e: JournalEvent): string | undefined =>
  e.type === 'intervention' ? str(e.payload.action) : undefined;

function originOf(raw: string): IntentOrigin {
  if (raw.startsWith('charter-wp')) return 'charter-wp';
  return 'human-request';
}

/** The intent a run's own `run intent` names, if it is well formed (journal is data). */
export function journaledIntent(run: RunRecord): Intent | undefined {
  for (const e of run.events) {
    if (action(e) !== INTENT_ACTIONS.intent) continue;
    const i = e.payload.intent as { id?: unknown; origin?: unknown } | undefined;
    const id = str(i?.id);
    const origin = str(i?.origin);
    if (!id || !origin) continue;
    return { key: `${origin}|${id}`, id, origin: originOf(origin) };
  }
  return undefined;
}

/** The parent run of a fork, from its `run started` event. */
function parentOf(run: RunRecord): string | undefined {
  const start = run.events.find((e) => action(e) === INTENT_ACTIONS.started);
  const parent = start?.payload.parent as { runId?: unknown } | undefined;
  return str(parent?.runId);
}

/** True when the run said it ran unattended (its `run intent`, D-029 R1). */
export function unattended(run: RunRecord): boolean {
  return run.events.some(
    (e) => action(e) === INTENT_ACTIONS.intent && e.payload.unattended === true,
  );
}

function resolve(runs: JournalRuns, run: RunRecord, depth: number): Intent {
  const own = journaledIntent(run);
  if (own) return own;
  const parent = parentOf(run);
  const up = parent && parent !== run.key ? runs.byKey.get(parent) : undefined;
  if (up && depth < MAX_FORK_DEPTH) return resolve(runs, up, depth + 1);
  return { key: `proxy|${run.key}`, id: run.key, origin: 'proxy' };
}

/** The intent of every run, keyed by run key. Pure. */
export function intentsOf(runs: JournalRuns): Map<string, Intent> {
  const out = new Map<string, Intent>();
  for (const r of runs.runs) out.set(r.key, resolve(runs, r, 0));
  return out;
}

/** True when the run was started (a `run started` or `run intent` was journaled). */
export function started(run: RunRecord): boolean {
  return run.events.some((e) => {
    const a = action(e);
    return a === INTENT_ACTIONS.started || a === INTENT_ACTIONS.intent;
  });
}
