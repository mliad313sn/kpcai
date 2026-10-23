/**
 * S10 R5 from the journal (ADR-0035): a run's assurance label is computed from what was
 * journaled in its session (critic verdicts with their providers, real test runs per the
 * P4-F10 rules), never from what a model says about its own work.
 */
import type { Kernel, RunOutcome } from '@kernelpai/kernel';
import { nodeWork, splitRuns } from '@kernelpai/learning';
import { assuranceOf, type AssuranceResult, type NodeFacts } from '@kernelpai/program';

/** Protocols with a critic step; a node under another one is not a reviewed deliverable. */
const REVIEWED: ReadonlySet<string> = new Set(['author_critic']);

function planProtocols(plan: unknown): Map<string, string> {
  const nodes = (plan as { nodes?: unknown } | undefined)?.nodes;
  const out = new Map<string, string>();
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes as Array<Record<string, unknown>>)
    if (typeof n['id'] === 'string' && typeof n['protocol'] === 'string')
      out.set(n['id'], n['protocol']);
  return out;
}

/** The run finished, was not cancelled, and every node ended ok. */
export function cleanFinish(o: RunOutcome | undefined): boolean {
  return o?.status === 'finished' && !o.cancelled && o.result.ok;
}

export function runAssurance(
  kernel: Kernel,
  sessionId: string,
  runId: string,
  outcome: RunOutcome | undefined,
): AssuranceResult & { testsPassed?: boolean } {
  const events = kernel.events(sessionId, 100_000);
  const run = splitRuns(events, () => '').byKey.get(runId);
  const nodes: NodeFacts[] = [];
  const protocols = planProtocols(run?.plan?.payload['plan']);
  for (const w of run ? nodeWork(run).values() : []) {
    nodes.push({
      nodeId: w.nodeId,
      reviewable: REVIEWED.has(protocols.get(w.nodeId) ?? 'author_critic'),
      ...(w.producer ? { producer: w.producer.provider } : {}),
      verdicts: w.verdicts.map((v) => ({
        authorProvider: v.author.provider,
        criticProvider: v.critic.provider,
        approved: v.approved,
        seq: v.seq,
      })),
      ...(w.tests ? { tests: { passed: w.tests.passed } } : {}),
    });
  }
  const r = assuranceOf({ ok: cleanFinish(outcome), nodes });
  const tested = nodes.filter((n) => n.tests);
  if (!tested.length) return r;
  return { ...r, testsPassed: tested.every((n) => n.tests?.passed) };
}
