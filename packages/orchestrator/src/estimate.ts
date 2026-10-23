import type {
  Candidate,
  GraphNode,
  ModelRef,
  ProtocolName,
  Router,
  RoutingConstraints,
  TaskGraph,
} from '@kernelpai/core';
import {
  heuristicText,
  nodeOutput,
  placeholderContext,
  planSteps,
  type StepContext,
  type StepEstimate,
  type TextSize,
} from './estimate-steps.js';
import { sumBands, type CostBand, type SpreadFn } from './band.js';
import { applyReviewPolicy, type ReviewPolicy } from './review-policy.js';
import { effectiveProtocol, upgradeReason } from './runner.js';
import { DEFAULT_MAX_REVISIONS, DEFAULT_VOTERS, type PlannedNode } from './types.js';

/**
 * Tokens assumed for each dependency's output, and for the work a critic, rebuttal or
 * judge reads, when the model producing it has no history (with a history, the producer's
 * learned output size is used instead). 4,000 = a quarter of the default 16,000-token
 * output cap, the same typical-output heuristic as the core cost estimator.
 */
export const DEFAULT_DEPENDENCY_ALLOWANCE_TOKENS = 4000;

/** Model calls per protocol with default settings (tool rounds are priced per call). */
export const PROTOCOL_ROUNDS: Readonly<Record<ProtocolName, { min: number; max: number }>> = {
  solo: { min: 1, max: 1 },
  // author, critic; then per revision a revision and a critic; plus one critic retry.
  author_critic: { min: 2, max: 3 + 2 * DEFAULT_MAX_REVISIONS },
  // two openings, two rebuttals, a judge (+ one judge retry).
  debate: { min: 5, max: 6 },
  // each voter once (+ one retry each).
  vote: { min: DEFAULT_VOTERS, max: 2 * DEFAULT_VOTERS },
};

export interface NodeEstimate {
  nodeId: string;
  /** Effective protocol (code, tests and critical solo nodes count as author+critic). */
  protocol: ProtocolName;
  /** Why the planned protocol was upgraded, if it was. */
  upgraded?: string;
  /** First step's model, null when it could not be routed. */
  ref: ModelRef | null;
  /** Expected cost of one call of the first step. */
  perCallUsd: number;
  /** Total calls of all steps. */
  rounds: { min: number; max: number };
  minUsd: number;
  /** Upper expectation (principle 6 prefers not to underestimate): every revision/retry. */
  expectedUsd: number;
  /** Per-role breakdown: who would do what, and for how much. */
  steps: StepEstimate[];
  /** Low–high cost from the calibration spread and the protocol's call counts (R-302). */
  band: CostBand;
  /** Size of the node's output, the context its dependants read. */
  output: TextSize;
  /** The user's model for the first step, when the node is pinned (R-301). */
  pinned?: ModelRef;
  /** Why the node cannot run as planned (no provider, diversity impossible). */
  error?: string;
}

export interface GraphEstimate {
  nodes: NodeEstimate[];
  minUsd: number;
  totalUsd: number;
  /** True when every node can run as planned. */
  complete: boolean;
  /** `<nodeId>: <why>` for each node that cannot. */
  problems: string[];
  /** Sum of the node bands (R-302); `minUsd`/`totalUsd` stay as before. */
  band: CostBand;
}

export interface EstimateDeps {
  router: Router;
  candidates: readonly Candidate[];
  constraints?: RoutingConstraints;
  /** Same meaning and defaults as `OrchestratorOptions`. */
  voters?: number;
  maxRevisions?: number;
  allowSameProvider?: boolean;
  /** Debate judges (`OrchestratorOptions.judges`). */
  judges?: number;
  /** Review depth by criticality (R-404), applied as the runner applies it. */
  reviewPolicy?: ReviewPolicy;
  /** Default `DEFAULT_DEPENDENCY_ALLOWANCE_TOKENS`. */
  dependencyAllowanceTokens?: number;
  /** Output spread from history (e.g. `outputSpread(journal)`); else a heuristic band. */
  spread?: SpreadFn;
  /** Providers that actually served finished nodes (used instead of their estimate). */
  known?: ReadonlyMap<string, readonly string[]>;
}

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const sum = (xs: number[]): number => r6(xs.reduce((a, b) => a + b, 0));

/**
 * Cost of a graph before it runs (ADR-0017, review P2-F9): every step of every node's
 * protocol is routed as the runner would route it (critic with the author excluded, judge
 * with the debaters excluded, voters from distinct providers, revisions and rebuttals on
 * their author's model, a review away from upstream providers), with dependency context
 * counted at each dependency's output size (learned, else `dependencyAllowanceTokens`),
 * times its call count. The band takes the low and high sizes of every text a step reads.
 */
export function estimateGraph(given: TaskGraph, deps: EstimateDeps): GraphEstimate {
  const graph = applyReviewPolicy(given, deps.reviewPolicy).graph;
  const memo = new Map<string, NodeEstimate>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const allowance = deps.dependencyAllowanceTokens ?? DEFAULT_DEPENDENCY_ALLOWANCE_TOKENS;
  const visit = (node: GraphNode, path: Set<string>): NodeEstimate => {
    const known = memo.get(node.id);
    if (known) return known;
    path.add(node.id);
    const sizes = new Map<string, TextSize>();
    const upstream = node.dependsOn.flatMap((id) => {
      const dep = byId.get(id);
      const e = dep && !path.has(id) ? visit(dep, path) : undefined;
      if (e) sizes.set(id, e.output);
      const served = deps.known?.get(id);
      if (served) return [...served];
      return e ? e.steps.map((s) => s.ref.provider) : [];
    });
    const size = (id: string): TextSize => sizes.get(id) ?? heuristicText(allowance);
    const e = estimateNode(node, deps, [...new Set(upstream)], size);
    memo.set(node.id, e);
    return e;
  };
  const nodes = graph.nodes.map((n) => visit(n, new Set()));
  return {
    nodes,
    minUsd: sum(nodes.map((n) => n.minUsd)),
    totalUsd: sum(nodes.map((n) => n.expectedUsd)),
    complete: nodes.every((n) => n.error === undefined),
    problems: nodes.flatMap((n) => (n.error ? [`${n.nodeId}: ${n.error}`] : [])),
    band: sumBands(nodes.map((n) => n.band)),
  };
}

function estimateNode(
  node: PlannedNode,
  deps: EstimateDeps,
  upstream: string[],
  size: (id: string) => TextSize,
): NodeEstimate {
  const protocol = effectiveProtocol(node);
  const allowance = deps.dependencyAllowanceTokens ?? DEFAULT_DEPENDENCY_ALLOWANCE_TOKENS;
  const x: StepContext = {
    router: deps.router,
    candidates: deps.candidates,
    constraints: deps.constraints ?? {},
    allowSameProvider: deps.allowSameProvider === true,
    maxRevisions: deps.maxRevisions ?? DEFAULT_MAX_REVISIONS,
    voters: deps.voters ?? DEFAULT_VOTERS,
    judges: deps.judges,
    node,
    context: placeholderContext(node, allowance, size),
    allowance,
    upstream,
    pin: node.model,
    spread: deps.spread,
  };
  const planned = planSteps(x, protocol);
  const { steps } = planned;
  const first = steps[0];
  const upgraded = upgradeReason(node);
  return {
    nodeId: node.id,
    protocol,
    ...(upgraded ? { upgraded } : {}),
    ref: first?.ref ?? null,
    perCallUsd: first?.perCallUsd ?? 0,
    rounds: {
      min: steps.reduce((a, s) => a + s.calls.min, 0),
      max: steps.reduce((a, s) => a + s.calls.max, 0),
    },
    minUsd: sum(steps.map((s) => s.minUsd)),
    expectedUsd: sum(steps.map((s) => s.expectedUsd)),
    steps,
    band: sumBands(steps.map((s) => s.band)),
    output: nodeOutput(steps, allowance),
    ...(node.model ? { pinned: node.model } : {}),
    ...(planned.ok ? {} : { error: planned.error }),
  };
}

export type { StepEstimate } from './estimate-steps.js';
