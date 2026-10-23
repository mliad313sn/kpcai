import {
  refToString,
  type Candidate,
  type ModelRef,
  type Router,
  type RoutingConstraints,
  type RoutingDecision,
  type ScoredCandidate,
  type TaskNode,
} from '@kernelpai/core';
import {
  OrchestrationError,
  type NodeConstraint,
  type OrchestratorOptions,
  type StepSpec,
} from './types.js';

export const sameRef = (a: ModelRef, b: ModelRef): boolean =>
  a.provider === b.provider && a.model === b.model;

/** Moves `ref` to the front of the decision when it is one of its candidates. */
export function preferRef(decision: RoutingDecision, ref: ModelRef): RoutingDecision {
  if (sameRef(decision.chosen.ref, ref)) return decision;
  const hit = decision.fallbacks.find((f) => sameRef(f.ref, ref));
  if (!hit) return decision;
  return {
    ...decision,
    chosen: hit,
    fallbacks: [decision.chosen, ...decision.fallbacks.filter((f) => f !== hit)],
    reason: `${refToString(ref)} preferred (same author); ${decision.reason}`,
  };
}

/** Candidates of a decision after `ref`, as a new decision (undefined when none remain). */
export function decisionAfter(
  decision: RoutingDecision,
  ref: ModelRef,
): RoutingDecision | undefined {
  const all = [decision.chosen, ...decision.fallbacks];
  const i = all.findIndex((c) => sameRef(c.ref, ref));
  const rest = all.slice(i + 1);
  const [chosen, ...fallbacks] = rest;
  if (i === -1 || !chosen) return undefined;
  return { ...decision, chosen, fallbacks, reason: `next after ${refToString(ref)}` };
}

/** A one-candidate decision: retry exactly this model. */
export function onlyDecision(nodeId: string, c: ScoredCandidate): RoutingDecision {
  return {
    nodeId,
    chosen: c,
    fallbacks: [],
    rejected: [],
    reason: `retry on ${refToString(c.ref)}`,
    elapsedMs: 0,
  };
}

/** The candidate of `decision` that served `ref`. */
export function servedCandidate(decision: RoutingDecision, ref: ModelRef): ScoredCandidate {
  return (
    [decision.chosen, ...decision.fallbacks].find((c) => sameRef(c.ref, ref)) ?? decision.chosen
  );
}

/**
 * Routes a node onto the user's pinned model only (principle 4): the router still checks
 * that model (constraints, context window, modalities, exclusions) and prices it; there is
 * no fallback to another model. Throws when the model is not a candidate or is rejected.
 */
export function routePinned(
  router: Router,
  node: TaskNode,
  candidates: readonly Candidate[],
  constraints: RoutingConstraints,
  pin: ModelRef,
): RoutingDecision {
  const only = candidates.filter((c) => sameRef(c.ref, pin));
  if (only.length === 0) {
    throw new Error(`model ${refToString(pin)} chosen by the user is not available`);
  }
  const d = router.route(node, only, constraints);
  return { ...d, fallbacks: [], reason: `${refToString(pin)} chosen by the user; ${d.reason}` };
}

export type DiversityNote = 'waived' | undefined;

export interface Routed {
  decision: RoutingDecision;
  diversity: DiversityNote;
  excluded: string[];
}

/**
 * Routes a step with principle 2: `spec.exclude` providers are excluded. When that leaves
 * nobody, a `hard` step fails unless `allowSameProvider` (then it routes without the
 * exclusion, reported as `waived` so the caller journals it); a `strict` step always fails.
 */
export function routeDiverse(
  o: OrchestratorOptions,
  node: TaskNode,
  spec: StepSpec,
  pin?: ModelRef,
): Routed {
  const nc = o.nodeConstraints?.(node.id);
  if (!nc) return routeWith(o, o.constraints ?? {}, node, spec, pin);
  try {
    return routeWith(o, withNode(o.constraints, nc), node, spec, pin);
  } catch (err) {
    throw because(nc, err);
  }
}

/** The run's constraints with a node's on top (lists added, other fields replaced). */
function withNode(base: RoutingConstraints | undefined, nc: NodeConstraint): RoutingConstraints {
  const b = base ?? {};
  const c = nc.constraints;
  const list = (k: 'deniedProviders' | 'deniedModels' | 'excludeProviders'): string[] => [
    ...(b[k] ?? []),
    ...(c[k] ?? []),
  ];
  return {
    ...b,
    ...c,
    deniedProviders: list('deniedProviders'),
    deniedModels: list('deniedModels'),
    excludeProviders: list('excludeProviders'),
  };
}

/** The error of a step a node constraint left without a model, with the constraint's reason. */
function because(nc: NodeConstraint, err: unknown): Error {
  const msg = `${nc.reason}: ${err instanceof Error ? err.message : String(err)}`;
  return err instanceof OrchestrationError ? new OrchestrationError(msg) : new Error(msg);
}

/**
 * A fixed decision (a retry, a revision on the author) kept to the candidates that meet the
 * node's constraints, checked by the router; throws with the reason when none does.
 */
export function constrainDecision(
  o: OrchestratorOptions,
  node: TaskNode,
  decision: RoutingDecision,
): RoutingDecision {
  const nc = o.nodeConstraints?.(node.id);
  if (!nc) return decision;
  const c = withNode(o.constraints, nc);
  const ok = [decision.chosen, ...decision.fallbacks].filter((k) => {
    try {
      routePinned(o.router, node, o.candidates, c, k.ref);
      return true;
    } catch {
      return false;
    }
  });
  const [chosen, ...fallbacks] = ok;
  if (!chosen) {
    const refs = [decision.chosen, ...decision.fallbacks].map((k) => refToString(k.ref));
    throw new Error(`${nc.reason}: ${refs.join(', ')} not allowed for this step`);
  }
  if (chosen === decision.chosen && fallbacks.length === decision.fallbacks.length) return decision;
  return { ...decision, chosen, fallbacks };
}

function routeWith(
  o: OrchestratorOptions,
  base: RoutingConstraints,
  node: TaskNode,
  spec: StepSpec,
  pin?: ModelRef,
): Routed {
  const excluded = [...new Set(spec.exclude ?? [])];
  const merged: RoutingConstraints = {
    ...base,
    excludeProviders: [...(base.excludeProviders ?? []), ...excluded],
  };
  const route = (c: RoutingConstraints): RoutingDecision =>
    pin ? routePinned(o.router, node, o.candidates, c, pin) : o.router.route(node, o.candidates, c);
  try {
    return { decision: route(merged), diversity: undefined, excluded };
  } catch (err) {
    if (excluded.length === 0) throw err;
    const mode = spec.diversity ?? 'hard';
    if (mode === 'strict' || o.allowSameProvider !== true) {
      throw new OrchestrationError(
        `diversity (principle 2): no provider other than ${excluded.join(', ')} can act as ${spec.role} on node ${node.id}; add another provider${mode === 'strict' ? '' : ' or pass allowSameProvider to waive it'}`,
      );
    }
    return { decision: route(base), diversity: 'waived', excluded };
  }
}
