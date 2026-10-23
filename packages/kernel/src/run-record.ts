/**
 * A run's outcome, journaled so that a later process can tell whether its output may be
 * written (review P3-F7): `kpai merge` in a new process, or a console restarted after the
 * run, must refuse a cancelled run exactly as the kernel that ran it would.
 */
import type { Journal } from '@kernelpai/journal';
import type { JournalEventInput } from '@kernelpai/journal';
import { extensionsUsed } from './extensions/assign.js';
import { summarizeRules } from './rules.js';
import type { GraphOptions } from './setup.js';
import type { Plan, RunOutcome } from './types.js';

export const OUTCOME_ACTION = 'run outcome';
export const CANCEL_ACTION = 'cancel graph';

/** How many recent sessions a lookup reads (a run id is a UUID: one hit is enough). */
const SCAN_SESSIONS = 500;

export interface RecordedOutcome {
  /** `failed`: the run stopped on an unexpected error. */
  status: RunOutcome['status'] | 'failed';
  cancelled: boolean;
}

/** Journals how a run ended, with its id. */
export function recordOutcome(
  journal: Journal,
  sessionId: string,
  runId: string,
  o: RunOutcome | undefined,
): void {
  const payload = {
    action: OUTCOME_ACTION,
    runId,
    status: o?.status ?? 'failed',
    cancelled: o?.status === 'finished' && o.cancelled,
    // D-028: providers and source, so a restarted program reads them from the journal.
    ...(o?.status === 'finished' && o.providers
      ? { providers: o.providers, source: o.source, sources: o.sources }
      : {}),
  };
  journal.append({ sessionId, type: 'intervention', payload });
}

/**
 * The journaled outcome of a run, or undefined when none was recorded (still running in
 * another process, killed, or unknown). A journaled cancel of the run counts as cancelled
 * even when no outcome follows it.
 */
export function recordedOutcome(journal: Journal, runId: string): RecordedOutcome | undefined {
  let found: RecordedOutcome | undefined;
  let cancelled = false;
  for (const s of journal.sessions(SCAN_SESSIONS)) {
    for (const e of journal.events({ sessionId: s.id, limit: 100_000 })) {
      if (e.type !== 'intervention' || e.payload.runId !== runId) continue;
      if (e.payload.action === CANCEL_ACTION) cancelled = true;
      if (e.payload.action === OUTCOME_ACTION) {
        const status = e.payload.status as RecordedOutcome['status'];
        found = { status, cancelled: e.payload.cancelled === true };
      }
    }
  }
  return found && { ...found, cancelled: found.cancelled || cancelled };
}

/** Why a run's output may not be written, or undefined when it may (finished, not cancelled). */
export function notWritable(runId: string, o: RecordedOutcome | undefined): string | undefined {
  if (!o) return `run ${runId} has no recorded outcome (unknown, unfinished or interrupted)`;
  if (o.status !== 'finished' || o.cancelled)
    return `run ${runId} was cancelled or not run: nothing is merged`;
  return undefined;
}

/**
 * Run-time options of `run.start` on an approved plan: the waivers (`overBudget`,
 * `allowSameProvider`) come from the plan the user approved, never from the start request
 * (review P3-F6, ADR-0019 addendum).
 */
export function runFlags(plan: GraphOptions, given: GraphOptions | undefined): GraphOptions {
  const { overBudget, allowSameProvider } = plan;
  return { ...plan, ...given, overBudget, allowSameProvider };
}

/** The plan a run starts from, as journaled before it runs (names only, never content). */
export function planRecord(p: Plan): JournalEventInput {
  return {
    sessionId: p.sessionId,
    type: 'routing',
    nodeId: p.graph.id,
    payload: {
      plan: p.graph,
      estimate: p.estimate,
      ...(p.edits ? { edits: p.edits } : {}),
      // Which rule files every node was given (names only, R-306).
      rules: summarizeRules(p.rules.rules),
      // Which memory facts every node was given: ids and sources only (ADR-0027).
      ...(p.memory ? { memory: p.memory.summary } : {}),
      packs: p.packs.packs.map((x) => ({ id: x.id, reason: x.reason })),
      zones: p.packs.zones,
      // Which skill and agent each node uses: names only (R-502).
      extensions: extensionsUsed(p.graph),
    },
  };
}
