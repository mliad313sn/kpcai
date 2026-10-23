/** Planning for the kernel: a plan with cost band and reasons, and checking a user's edits. */
import { randomUUID } from 'node:crypto';
import type { TaskGraph } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import {
  estimateGraph,
  outputSpread,
  validatePlan,
  type EstimateDeps,
  type PlanCheck,
} from '@kernelpai/orchestrator';
import { BudgetGate, type GateHost } from './budget-gate.js';
import { money } from './env.js';
import { KernelError } from './errors.js';
import { explainEstimate } from './routing-info.js';
import { graphSetup, plannerFor, type GraphOptions, type GraphSetup } from './setup.js';
import type { Plan } from './types.js';

export interface PlanningContext {
  gateHost: GateHost;
  journal: Journal;
}

/** Estimate inputs of a plan; the band uses the output spread learned from this journal. */
function estimateDeps(s: GraphSetup, o: GraphOptions, journal: Journal): EstimateDeps {
  return {
    router: s.router,
    candidates: s.candidates,
    constraints: s.constraints,
    allowSameProvider: o.allowSameProvider === true,
    spread: outputSpread(journal),
  };
}

export async function makePlan(
  c: PlanningContext,
  request: string,
  options: GraphOptions,
  sessionId: string,
): Promise<Plan> {
  const { gateHost: host, journal } = c;
  const setup = await graphSetup(host.env, host.say, options, journal);
  const m = money(host.env);
  if (options.planner === 'model')
    host.say('planning with a model: this is a paid call, budget-checked\n');
  const gate = new BudgetGate(host, journal, { sessionId, nodeId: 'planner', m }, options);
  const planner = plannerFor(options, setup, journal, sessionId, (x, l) => gate.allow(x, l));
  const graph = await planner.plan(request, { root: host.cwd });
  const est = estimateGraph(graph, estimateDeps(setup, options, journal));
  const estimate = explainEstimate(graph, est, setup);
  return { planId: randomUUID(), sessionId, request, graph, estimate, options, setup, m };
}

/**
 * Checks a plan the user edited (R-301): untrusted JSON, validated and re-estimated by the
 * orchestrator against the plan as proposed. The graph keeps the proposal's id and request.
 */
export function checkEdit(
  plan: Plan,
  edited: unknown,
  journal: Journal,
): { check: PlanCheck; graph: TaskGraph } {
  const g = (edited ?? {}) as Partial<TaskGraph>;
  const graph: TaskGraph = {
    ...plan.graph,
    nodes: Array.isArray(g.nodes) ? g.nodes : [],
    id: plan.graph.id,
    request: plan.request,
  };
  const check = validatePlan(graph, {
    ...estimateDeps(plan.setup, plan.options, journal),
    original: plan.graph,
  });
  return { check, graph };
}

/** The plan to run: the proposal, or the user's edited version once it checks out. */
export function editedPlan(plan: Plan, edited: unknown, journal: Journal): Plan {
  const { check, graph } = checkEdit(plan, edited, journal);
  if (!check.ok || !check.estimate) {
    throw new KernelError('invalid', `the edited plan cannot run: ${check.problems.join('; ')}`);
  }
  const estimate = explainEstimate(graph, check.estimate, plan.setup);
  return { ...plan, graph, estimate, edits: check.changes };
}
