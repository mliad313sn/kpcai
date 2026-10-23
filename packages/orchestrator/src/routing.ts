import {
  refToString,
  type ModelRef,
  type RoutingConstraints,
  type RoutingDecision,
  type ScoredCandidate,
  type TaskNode,
} from '@kernelpai/core';
import { OrchestrationError, type OrchestratorOptions, type StepSpec } from './types.js';

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

export type DiversityNote = 'waived' | 'reduced' | undefined;

export interface Routed {
  decision: RoutingDecision;
  diversity: DiversityNote;
  excluded: string[];
}

/**
 * Routes a step with principle 2: `spec.exclude` providers are excluded. When that leaves
 * nobody, a `hard` step fails unless `allowSameProvider`; a `soft` one routes without the
 * exclusion. Both overrides are reported so the caller can journal them.
 */
export function routeDiverse(o: OrchestratorOptions, node: TaskNode, spec: StepSpec): Routed {
  const base: RoutingConstraints = o.constraints ?? {};
  const excluded = [...new Set(spec.exclude ?? [])];
  const merged: RoutingConstraints = {
    ...base,
    excludeProviders: [...(base.excludeProviders ?? []), ...excluded],
  };
  const route = (c: RoutingConstraints): RoutingDecision => o.router.route(node, o.candidates, c);
  try {
    return { decision: route(merged), diversity: undefined, excluded };
  } catch (err) {
    if (excluded.length === 0) throw err;
    const mode = spec.diversity ?? 'hard';
    const hard = mode !== 'soft';
    if (mode === 'strict' || (hard && o.allowSameProvider !== true)) {
      throw new OrchestrationError(
        `diversity (principle 2): no provider other than ${excluded.join(', ')} can act as ${spec.role} on node ${node.id}; add another provider${mode === 'strict' ? '' : ' or pass allowSameProvider to waive it'}`,
      );
    }
    return { decision: route(base), diversity: hard ? 'waived' : 'reduced', excluded };
  }
}
