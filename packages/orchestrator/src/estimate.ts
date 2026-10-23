import type {
  ModelRef,
  ProtocolName,
  Router,
  Candidate,
  RoutingConstraints,
  TaskGraph,
} from '@kernelpai/core';
import { effectiveProtocol } from './runner.js';
import { DEFAULT_VOTERS } from './types.js';

/** Expected model calls per protocol (tool rounds not included). */
export const PROTOCOL_ROUNDS: Readonly<Record<ProtocolName, { min: number; max: number }>> = {
  solo: { min: 1, max: 1 },
  author_critic: { min: 2, max: 3 },
  debate: { min: 5, max: 5 },
  vote: { min: DEFAULT_VOTERS, max: DEFAULT_VOTERS },
};

export interface NodeEstimate {
  nodeId: string;
  /** Effective protocol (a critical solo node counts as author+critic). */
  protocol: ProtocolName;
  /** First-choice model, null when routing failed. */
  ref: ModelRef | null;
  /** Expected cost of one call by the first choice. */
  perCallUsd: number;
  rounds: { min: number; max: number };
  /** perCallUsd × rounds.min */
  minUsd: number;
  /** perCallUsd × rounds.max (shown before running: principle 6 prefers not to underestimate). */
  expectedUsd: number;
  /** Why the node could not be routed. */
  error?: string;
}

export interface GraphEstimate {
  nodes: NodeEstimate[];
  minUsd: number;
  totalUsd: number;
  /** True when every node could be routed. */
  complete: boolean;
}

export interface EstimateDeps {
  router: Router;
  candidates: readonly Candidate[];
  constraints?: RoutingConstraints;
  /** Voters per vote node; default 3. */
  voters?: number;
}

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Cost of a graph before it runs (ADR-0017): for each node, the router's expected cost of
 * its first choice times the protocol's expected rounds; the total is their sum.
 */
export function estimateGraph(graph: TaskGraph, deps: EstimateDeps): GraphEstimate {
  const nodes = graph.nodes.map((node): NodeEstimate => {
    const protocol = effectiveProtocol(node);
    const base = PROTOCOL_ROUNDS[protocol];
    const rounds =
      protocol === 'vote' && deps.voters ? { min: deps.voters, max: deps.voters } : base;
    try {
      const d = deps.router.route(node, deps.candidates, deps.constraints ?? {});
      const per = d.chosen.estimate.expectedCostUsd;
      return {
        nodeId: node.id,
        protocol,
        ref: d.chosen.ref,
        perCallUsd: per,
        rounds,
        minUsd: r6(per * rounds.min),
        expectedUsd: r6(per * rounds.max),
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        nodeId: node.id,
        protocol,
        ref: null,
        perCallUsd: 0,
        rounds,
        minUsd: 0,
        expectedUsd: 0,
        error,
      };
    }
  });
  return {
    nodes,
    minUsd: r6(nodes.reduce((s, n) => s + n.minUsd, 0)),
    totalUsd: r6(nodes.reduce((s, n) => s + n.expectedUsd, 0)),
    complete: nodes.every((n) => n.ref !== null),
  };
}
