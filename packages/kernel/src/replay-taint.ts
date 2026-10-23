/**
 * Local-only memory across replay and fork (review P4-R1, ADR-0027 §6). A recorded node
 * whose output may quote local-only facts stays tainted when it is reused or replayed
 * from: the nodes that run again after it are held on local providers, or fail closed.
 * Both also get today's memory, so the local adapter swap, the redactor of cloud-bound
 * requests and the journal wrapper apply to them as to a run.
 */
import { LocalTaint } from '@kernelpai/memory';
import type { RecordedRun } from '@kernelpai/orchestrator';
import type { GateHost } from './budget-gate.js';
import { hasLocalOnly, loadMemory, type LoadedMemory, type TaintSeed } from './memory.js';
import { busPacks, policyFor, type SelectedPacks } from './packs.js';
import type { GraphSetup } from './setup.js';

/** Today's memory for a replay or a fork, read like a plan's (zones of the current packs). */
export async function currentMemory(
  host: GateHost,
  packs: SelectedPacks,
  sessionId: string,
): Promise<LoadedMemory> {
  const { policy } = await policyFor(host.env, busPacks(packs, sessionId), undefined, host.cwd);
  return loadMemory(host.env, host.cwd, sessionId, policy.zoneSet(), host.say);
}

/** A provider that is local today, or no longer known (counted as local: conservative). */
function servedLocally(setup: GraphSetup, provider: string): boolean {
  try {
    return setup.registry.get(provider).descriptor.kind === 'local';
  } catch {
    return true;
  }
}

/**
 * The recorded nodes whose output may quote local-only facts: those marked `localTaint`
 * when recorded and, once there is something to protect (a marked record, or local-only
 * facts in today's memory), every node a local or unknown provider contributed to. Runs
 * journaled before the mark are thus derived from their contributions.
 */
export function recordedTaint(run: RecordedRun, setup: GraphSetup, memory: LoadedMemory): string[] {
  const recs = Object.values(run.nodes);
  const marked = recs.filter((r) => r.localTaint === true).map((r) => r.nodeId);
  if (marked.length === 0 && !hasLocalOnly(memory)) return [];
  const derived = recs
    .filter((r) => r.result.contributions.some((c) => servedLocally(setup, c.ref.provider)))
    .map((r) => r.nodeId);
  return [...new Set([...marked, ...derived])].sort();
}

/** A fork's seed: the tainted nodes it reuses (those it reruns produce new output). */
export function forkSeed(run: RecordedRun, tainted: readonly string[], rerun: readonly string[]) {
  const again = new Set(rerun);
  return { nodes: run.graph.nodes, ids: tainted.filter((id) => !again.has(id)) };
}

/**
 * A replay's seed: the tainted nodes upstream of the replayed one (its recorded input),
 * with the recorded graph so the taint reaches it through its dependencies.
 */
export function replaySeed(run: RecordedRun, nodeId: string, tainted: readonly string[]) {
  return { nodes: run.graph.nodes, ids: tainted.filter((id) => id !== nodeId) };
}

/** The tainted node `nodeId` reads from, if any (it is then held on local providers). */
export function taintedInput(seed: TaintSeed, nodeId: string): string | undefined {
  const taint = new LocalTaint(seed.nodes, seed.ids.length > 0);
  for (const id of seed.ids) taint.observe(id, true);
  return taint.source(nodeId);
}
