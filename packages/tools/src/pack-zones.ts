import { planZones, relaxKey, type Pack } from '@kernelpai/packs';
import type { ToolJournal } from './bus.js';
import { relaxationProblem, type PackZonePlan } from './zone-set.js';
import { HEURISTIC_ZONES, type ZoneRelaxation } from './zones.js';

export { relaxKey };

/** Zone requests of packs, for {@link createToolBus} (WI-S5-01). */
export interface PackZoneOptions {
  /**
   * Packs the user enabled for this session. Their additions always apply. Do not pass
   * packs that were only detected or suggested: a relaxation needs an enabled pack.
   */
  enabled: readonly Pack[];
  /**
   * `relaxKey(pack, allow)` of each relaxation the user approved after it was shown to
   * them (list `pending` from a first call, ask, then pass the answers here).
   */
  approved?: Iterable<string>;
  /** Session the relaxations are journaled under (default `tool-bus`). */
  sessionId?: string;
}

/**
 * Pure plan of the enabled packs' zone requests: additions, approved relaxations,
 * relaxations waiting for approval, and refusals (packs semantics plus this package's
 * stricter check, see {@link relaxationProblem}).
 */
export function planPackZones(options: PackZoneOptions): PackZonePlan {
  const approved = new Set(options.approved ?? []);
  const base = planZones(options.enabled, approved);
  const plan: PackZonePlan = {
    added: options.enabled.flatMap((p) => p.zones.add.map((glob) => ({ pack: p.id, glob }))),
    relaxed: [],
    pending: [],
    refused: base.refused.map((r) => ({ ...r })),
  };
  const sort = (r: ZoneRelaxation, into: ZoneRelaxation[]): void => {
    const problem = relaxationProblem(r.allow);
    if (problem === undefined) into.push({ ...r });
    else plan.refused.push({ pack: r.pack, allow: r.allow, problem });
  };
  for (const r of base.relaxed) sort(r, plan.relaxed);
  for (const r of base.pending) sort(r, plan.pending);
  return plan;
}

function append(
  journal: ToolJournal,
  sessionId: string,
  payload: Record<string, unknown>,
): boolean {
  try {
    journal.append({ sessionId, type: 'intervention', payload });
    return true;
  } catch {
    return false;
  }
}

/**
 * Journals every relaxation decision. A relaxation that cannot be journaled (no journal,
 * or the append failed) is not applied: it moves to `refused` (fail closed).
 */
export function journalPackZones(
  plan: PackZonePlan,
  journal: ToolJournal | undefined,
  sessionId = 'tool-bus',
): PackZonePlan {
  const out: PackZonePlan = { ...plan, relaxed: [], refused: [...plan.refused] };
  for (const r of plan.relaxed) {
    const payload = { action: 'zone relaxed', ...r, heuristics: [...HEURISTIC_ZONES] };
    if (journal && append(journal, sessionId, payload)) out.relaxed.push(r);
    else out.refused.push({ ...r, problem: `"${r.allow}" could not be journaled; not applied` });
  }
  if (!journal) return out;
  for (const r of plan.pending) {
    append(journal, sessionId, { action: 'zone relaxation pending approval', ...r });
  }
  for (const r of plan.refused) {
    append(journal, sessionId, { action: 'zone relaxation refused', ...r });
  }
  return out;
}

/** Lines for a plan or settings view: what packs changed in the zones, and why. */
export function describePackZones(plan: PackZonePlan): string[] {
  return [
    ...plan.added.map((a) => `zone added by ${a.pack}: ${a.glob}`),
    ...plan.relaxed.map((r) => `zone relaxed by ${r.pack}: ${r.allow} (${r.reason})`),
    ...plan.pending.map((r) => `needs your approval (${r.pack}): ${r.allow} — ${r.reason}`),
    ...plan.refused.map((r) => `refused (${r.pack}): ${r.problem}`),
  ];
}
