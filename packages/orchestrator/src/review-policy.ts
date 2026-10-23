import type { Criticality, GraphNode, ProtocolName, TaskGraph } from '@kernelpai/core';
import { deliverableOf, shapeOf } from './deliverable.js';
import type { PlannedNode } from './types.js';

/**
 * Review depth (R-404): `none` = solo, `critic` = author + one critic, `critics` = author +
 * two independent critics, `debate` = two debaters and a judge, `vote` = competence-weighted
 * vote.
 */
export type ReviewDepth = 'none' | 'critic' | 'critics' | 'debate' | 'vote';

/** Review depth per node criticality, set in the options (`reviewPolicy`). */
export type ReviewPolicy = Readonly<Record<Criticality, ReviewDepth>>;

/** The policy suggested by R-404: low → solo, normal → one critic, critical → two critics. */
export const SUGGESTED_REVIEW_POLICY: ReviewPolicy = {
  low: 'none',
  normal: 'critic',
  critical: 'critics',
};

export const REVIEW_DEPTHS: readonly ReviewDepth[] = [
  'none',
  'critic',
  'critics',
  'debate',
  'vote',
];

const DEPTH: Record<ReviewDepth, { protocol: ProtocolName; critics?: number }> = {
  none: { protocol: 'solo' },
  critic: { protocol: 'author_critic', critics: 1 },
  critics: { protocol: 'author_critic', critics: 2 },
  debate: { protocol: 'debate' },
  vote: { protocol: 'vote' },
};

/**
 * Principle 2: code, tests, and diff or file deliverables are always reviewed by an author +
 * critic. Their depth maps to `critic` at least; `debate` and `vote` (which would bypass the
 * patch review) map to two critics.
 */
const FLOOR: Record<ReviewDepth, ReviewDepth> = {
  none: 'critic',
  critic: 'critic',
  critics: 'critics',
  debate: 'critics',
  vote: 'critics',
};

/** True for nodes that may never go below author+critic (principle 2). */
export function mustBeReviewed(node: GraphNode): boolean {
  if (node.type === 'code_generation' || node.type === 'test') return true;
  const shape = shapeOf(deliverableOf(node as PlannedNode));
  return shape === 'diff' || shape === 'files';
}

export interface PolicyChange {
  nodeId: string;
  criticality: Criticality;
  depth: ReviewDepth;
  from: { protocol: ProtocolName; critics?: number };
  to: { protocol: ProtocolName; critics?: number };
  /** Set when principle 2 raised the policy's depth. */
  floor?: string;
}

/**
 * The node under the policy, and what changed. Only nodes planned as solo or author+critic
 * follow it (a planned debate or vote is a decision or closed choice, not a review depth),
 * and a `critique` node (itself a review of earlier nodes) is left as it is.
 */
export function reviewedNode(
  node: PlannedNode,
  policy: ReviewPolicy,
): { node: PlannedNode; change?: PolicyChange } {
  if (node.protocol !== 'solo' && node.protocol !== 'author_critic') return { node };
  if (node.type === 'critique') return { node };
  const asked = policy[node.criticality];
  if (!asked || !(asked in DEPTH)) return { node };
  const floored = mustBeReviewed(node) ? FLOOR[asked] : asked;
  const to = DEPTH[floored];
  const critics = to.protocol === 'author_critic' ? to.critics : undefined;
  if (node.protocol === to.protocol && (node.critics ?? 1) === (critics ?? 1)) return { node };
  const next: PlannedNode = { ...node, protocol: to.protocol };
  delete next.critics;
  if (critics !== undefined && critics > 1) next.critics = critics;
  const from = { protocol: node.protocol, ...(node.critics ? { critics: node.critics } : {}) };
  const change: PolicyChange = {
    nodeId: node.id,
    criticality: node.criticality,
    depth: floored,
    from,
    to: { protocol: to.protocol, ...(critics !== undefined ? { critics } : {}) },
    ...(floored !== asked
      ? { floor: `${node.type} keeps at least author+critic (principle 2)` }
      : {}),
  };
  return { node: next, change };
}

/** Applies the policy to every node (idempotent); the changes are for the journal and UI. */
export function applyReviewPolicy<G extends TaskGraph>(
  graph: G,
  policy: ReviewPolicy | undefined,
): { graph: G; changes: PolicyChange[] } {
  if (!policy) return { graph, changes: [] };
  const changes: PolicyChange[] = [];
  const nodes = (graph.nodes as PlannedNode[]).map((n) => {
    const r = reviewedNode(n, policy);
    if (r.change) changes.push(r.change);
    return r.node;
  });
  return { graph: { ...graph, nodes }, changes };
}

/** True when `x` is a complete policy (every criticality mapped to a known depth). */
export function isReviewPolicy(x: unknown): x is ReviewPolicy {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  return (['low', 'normal', 'critical'] as const).every((k) =>
    REVIEW_DEPTHS.includes(p[k] as ReviewDepth),
  );
}
