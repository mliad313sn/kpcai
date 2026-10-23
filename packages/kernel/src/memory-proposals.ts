/**
 * Memory proposals of a finished run (ADR-0027): the ```memory blocks of node outputs,
 * capped in count and size, screened, and put in the pending queue with their provenance
 * (the model, the run and the node). Nothing is stored here: a human confirms each one.
 */
import type { ContributionRole, GraphResult, ModelRef, ProtocolResult } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import { extractProposals, type MemoryScope } from '@kernelpai/memory';
import type { Env } from './env.js';
import { localTaint, memoryStore, NO_MEMORY } from './memory.js';
import { busPacks, folderKey, policyFor } from './packs.js';
import type { Plan } from './types.js';

export const MAX_PROPOSALS_PER_RUN = 10;

export interface ProposalContext {
  env: Env;
  /** The user's workspace (project memory is keyed on it, also for isolated runs). */
  cwd: string;
  journal: Journal;
  runId: string;
  plan: Plan;
}

const AUTHORS: readonly ContributionRole[] = ['revision', 'author', 'solo', 'judge'];

/** The model whose text became the node's output. */
function authorOf(r: ProtocolResult): ModelRef | undefined {
  const own = r.contributions.filter((c) => AUTHORS.includes(c.role));
  return (own.at(-1) ?? r.contributions.at(-1))?.ref;
}

interface Found {
  nodeId: string;
  source: string;
  layer: MemoryScope['layer'];
  text: string;
  localOnly: boolean;
}

/**
 * Nodes that saw local-only facts (a contribution from a local provider), or depend on
 * one that did (P4-F3): what they propose is kept local-only, whatever the model tagged.
 */
function taintedBy(c: ProposalContext, result: GraphResult): (nodeId: string) => boolean {
  const taint = localTaint(c.plan.memory ?? NO_MEMORY, c.plan.graph?.nodes ?? []);
  if (!taint.active) return () => false;
  const kind = (provider: string): string | undefined => {
    try {
      return c.plan.setup?.registry.get(provider).descriptor.kind;
    } catch {
      return undefined;
    }
  };
  for (const r of Object.values(result.results))
    for (const x of r.contributions) taint.observe(r.nodeId, kind(x.ref.provider) === 'local');
  return (nodeId) => taint.source(nodeId) !== undefined;
}

function found(
  result: GraphResult,
  tainted: (nodeId: string) => boolean,
): { list: Found[]; dropped: number } {
  const list: Found[] = [];
  let dropped = 0;
  for (const r of Object.values(result.results)) {
    if (!r.ok) continue;
    const ref = authorOf(r);
    const e = extractProposals(r.output);
    dropped += e.dropped;
    if (!ref) {
      dropped += e.proposals.length;
      continue;
    }
    const source = `${ref.provider}/${ref.model}`;
    const local = tainted(r.nodeId);
    for (const p of e.proposals)
      list.push({ nodeId: r.nodeId, source, ...p, localOnly: p.localOnly || local });
  }
  const kept = list.slice(0, MAX_PROPOSALS_PER_RUN);
  return { list: kept, dropped: dropped + list.length - kept.length };
}

/** Queues a run's proposals; returns the pending ids. Refusals are counted and journaled. */
export async function queueProposals(c: ProposalContext, result: GraphResult): Promise<string[]> {
  const { list, dropped } = found(result, taintedBy(c, result));
  if (list.length === 0 && dropped === 0) return [];
  const sessionId = c.plan.sessionId;
  const { policy } = await policyFor(c.env, busPacks(c.plan.packs, sessionId), undefined, c.cwd);
  const store = memoryStore(c.env, policy.zoneSet());
  const repo = await folderKey(c.cwd);
  const ids: string[] = [];
  const refused: string[] = [];
  for (const f of list) {
    const scope: MemoryScope =
      f.layer === 'user'
        ? { layer: 'user' }
        : f.layer === 'session'
          ? { layer: 'session', sessionId }
          : { layer: 'project', repo };
    try {
      const p = await store.propose(
        { scope, text: f.text, localOnly: f.localOnly },
        { source: f.source, evidence: [`run:${c.runId}`, `node:${f.nodeId}`] },
      );
      if (!ids.includes(p.id)) ids.push(p.id);
    } catch (err) {
      refused.push(`${f.nodeId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  c.journal.append({
    sessionId,
    type: 'intervention',
    payload: { action: 'memory proposed', runId: c.runId, ids, dropped, refused },
  });
  return ids;
}
