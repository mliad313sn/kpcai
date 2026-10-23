/**
 * S10 R5: one assurance label per delivered result, derived from journaled facts only
 * (critic verdicts by provider, test runs, CI for the exact commit, a human's `viewed`):
 *
 * - V0 unchecked;
 * - V1 every produced node with a critic step approved last by a critic of another provider;
 * - V2 V1 plus objective evidence (a passing test run and none failing, or CI green);
 * - V3 V2 plus a human opened the evidence before accepting.
 *
 * "Verified" in reports means ≥ V2 and nothing else. The label always says what earned it.
 */
import type { Assurance } from './schemas.js';

export interface NodeFacts {
  nodeId: string;
  /** Provider of the node's final answer; absent when the node produced nothing. */
  producer?: string;
  verdicts: Array<{
    authorProvider: string;
    criticProvider: string;
    approved: boolean;
    seq: number;
  }>;
  /** The node's last real test run (P4-F10 rules), if one ran. */
  tests?: { passed: boolean };
  /**
   * False for a node whose protocol has no critic step (solo, debate, vote): it is not a
   * reviewed deliverable and does not count either way. Default true.
   */
  reviewable?: boolean;
}

export interface RunFacts {
  /** The run finished, was not cancelled and every node ended ok. */
  ok: boolean;
  nodes: readonly NodeFacts[];
  /** CI for the exact head commit of the run's work. */
  ci?: { green: boolean };
  /** A human opened this run's evidence (S10 R6 J2). */
  viewed?: boolean;
}

export interface AssuranceResult {
  label: Assurance;
  /** What earned it, for people: "V1: approved by mock-delta (2 nodes); no tests". */
  basis: string;
}

function independentApproval(n: NodeFacts): string | undefined {
  const last = [...n.verdicts].sort((a, b) => a.seq - b.seq).at(-1);
  if (!last?.approved || last.criticProvider === last.authorProvider) return undefined;
  return last.criticProvider;
}

export function assuranceOf(f: RunFacts): AssuranceResult {
  if (!f.ok) return { label: 'V0', basis: 'V0: the run did not finish cleanly' };
  const produced = f.nodes.filter((n) => n.producer !== undefined && n.reviewable !== false);
  if (!produced.length) return { label: 'V0', basis: 'V0: no reviewed deliverable' };
  const critics = new Set<string>();
  for (const n of produced) {
    const critic = independentApproval(n);
    if (!critic)
      return { label: 'V0', basis: `V0: ${n.nodeId} has no approval from another provider` };
    critics.add(critic);
  }
  const review = `approved by ${[...critics].sort().join(', ')} (${produced.length} nodes)`;
  const tested = f.nodes.filter((n) => n.tests);
  const failed = tested.some((n) => n.tests?.passed === false);
  const passed = tested.filter((n) => n.tests?.passed).length;
  const ci = f.ci?.green === true;
  if (failed || (!passed && !ci)) {
    const why = failed ? 'a test run failed' : 'no tests or CI';
    return { label: 'V1', basis: `V1: ${review}; ${why}` };
  }
  const evidence = [passed ? `${passed} test run(s) passed` : '', ci ? 'CI green' : '']
    .filter(Boolean)
    .join(', ');
  if (f.viewed) return { label: 'V3', basis: `V3: ${review}; ${evidence}; evidence opened` };
  return { label: 'V2', basis: `V2: ${review}; ${evidence}` };
}

/** V3 is V2 plus a human's look; anything below V2 is unchanged by a look. */
export function withViewed(label: Assurance | undefined, viewed: boolean): Assurance {
  const l = label ?? 'V0';
  return l === 'V2' && viewed ? 'V3' : l;
}
