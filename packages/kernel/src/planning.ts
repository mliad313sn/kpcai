/** Planning for the kernel: a plan with cost band and reasons, and checking a user's edits. */
import { randomUUID } from 'node:crypto';
import type { TaskGraph } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import { accuracyNote, estimateAccuracy } from '@kernelpai/learning';
import {
  estimateGraph,
  outputSpread,
  validatePlan,
  type BudgetHook,
  type EstimateDeps,
  type PlanCheck,
} from '@kernelpai/orchestrator';
import { BudgetGate, type GateHost } from './budget-gate.js';
import { money } from './env.js';
import { KernelError } from './errors.js';
import { DecisionLog, explainEstimate, type ExplainedEstimate } from './routing-info.js';
import type { Env } from './env.js';
import { busPacks, noPacks, policyFor, selectPacks, type SelectedPacks } from './packs.js';
import { loadMemory, type LoadedMemory } from './memory.js';
import { loadRules, withNodeContext, type LoadedRules } from './rules.js';
import { assignAll, assignmentProblems, expandGraph } from './extensions/assign.js';
import { beforePlan } from './extensions/hook-bus.js';
import { loadExtensions, plannerCatalog, type LoadedExtensions } from './extensions/load.js';
import { checkScope } from './scope.js';
import { graphSetup, plannerFor, type GraphOptions, type GraphSetup } from './setup.js';
import type { Plan } from './types.js';

export interface PlanningContext {
  gateHost: GateHost;
  journal: Journal;
}

/**
 * Estimate inputs of a plan; the band uses the output spread learned from this journal.
 * The router records its decisions so the plan is explained with them (R-303).
 */
export function estimateDeps(
  s: GraphSetup,
  o: GraphOptions,
  journal: Journal,
): EstimateDeps & { router: DecisionLog } {
  return {
    router: new DecisionLog(s.router),
    candidates: s.candidates,
    constraints: s.constraints,
    allowSameProvider: o.allowSameProvider === true,
    spread: outputSpread(journal),
    // The band covers the protocols the run will use (R-404, ADR-0030).
    ...(s.reviewPolicy ? { reviewPolicy: s.reviewPolicy } : {}),
  };
}

export async function makePlan(
  c: PlanningContext,
  request: string,
  options: GraphOptions,
  sessionId: string,
): Promise<Plan> {
  const { gateHost: host, journal } = c;
  const setup = await graphSetup(host.env, host.say, options, journal, host.cwd);
  const m = money(host.env);
  const packs = await packsFor(host.env, host.cwd, host.say);
  const { rules, memory, extensions } = await workspaceContext(host, sessionId, packs);
  // R-502: before-plan hooks run before any planner call; a veto refuses the plan.
  await beforePlan(host, journal, sessionId, extensions.hooks, request, busPacks(packs, sessionId));
  if (options.planner === 'model')
    host.say('planning with a model: this is a paid call, budget-checked\n');
  const gate = new BudgetGate(host, journal, { sessionId, nodeId: 'planner', m }, options);
  const allow: BudgetHook = (x, l) => gate.allow(x, l);
  const planner = plannerFor(options, setup, journal, sessionId, allow, {
    // The planner sees skill and agent names and descriptions only (R-502).
    rulesText: [rules.text, memory.context, plannerCatalog(extensions)]
      .filter(Boolean)
      .join('\n\n'),
    packs: packs.selected,
  });
  const graph = assignAll(await planner.plan(request, { root: host.cwd }), options);
  const unknown = assignmentProblems(graph, extensions);
  if (unknown.length > 0) throw new KernelError('invalid', unknown.join('; '));
  const scope = await checkScope(packs.selected, host.cwd, options.scope, graph.nodes);
  // Estimated as it will run: with the rules, memory, agents and skills in front of each node.
  const deps = estimateDeps(setup, options, journal);
  const ctx = { rules, memory, extensions, setup };
  const explained = explainEstimate(estimateGraph(runnable(graph, ctx), deps), deps.router);
  // R-402: how estimates here compared with real costs, shown before launch.
  const estimate = { ...explained, accuracy: accuracyFor(journal, host.cwd, graph) };
  const base = { planId: randomUUID(), sessionId, request, graph, estimate, options, setup, m };
  return { ...base, rules, memory, packs, scope, extensions };
}

/**
 * What the workspace gives every node: rule files (R-306) read inside the jail with the
 * forbidden zones skipped, memory (ADR-0027) and extensions (R-502), before any model
 * call. Without a journal yet, pack relaxations are not applied to these reads (fail closed).
 */
async function workspaceContext(host: GateHost, sessionId: string, packs: SelectedPacks) {
  const { policy } = await policyFor(host.env, busPacks(packs, sessionId), undefined, host.cwd);
  const zones = policy.zoneSet();
  const rules = await loadRules(host.cwd, zones, host.say);
  const memory = await loadMemory(host.env, host.cwd, sessionId, zones, host.say);
  const extensions = await loadExtensions(host.env, host.cwd, zones);
  for (const x of extensions.problems) host.say(`  – extensions: ${x}\n`);
  return { rules, memory, extensions };
}

/** The published estimate accuracy for this workspace and these node types (R-402). */
function accuracyFor(journal: Journal, project: string, graph: TaskGraph): string {
  const types = graph.nodes.map((n) => n.type);
  return accuracyNote(estimateAccuracy(journal, { project }), types);
}

/** Packs and zones of the workspace; a pack failure leaves the policy's zones alone. */
async function packsFor(env: Env, cwd: string, say: (t: string) => void): Promise<SelectedPacks> {
  try {
    return await selectPacks(env, cwd);
  } catch (err) {
    const why = `domain packs not read: ${err instanceof Error ? err.message : String(err)}`;
    say(`  – ${why}\n`);
    return noPacks(env, why);
  }
}

/**
 * The graph the runner is given: each node with the repository rules and memory in front,
 * then its named agent and skill (R-502), its tools narrowed by them.
 */
export function runnable(
  graph: TaskGraph,
  ctx: {
    rules: LoadedRules;
    memory?: LoadedMemory | undefined;
    extensions?: LoadedExtensions | undefined;
    setup?: Pick<GraphSetup, 'candidates'>;
  },
): TaskGraph {
  const expanded = expandGraph(graph, ctx.extensions, ctx.setup?.candidates ?? []);
  return withNodeContext(expanded, { rules: ctx.rules.text, memory: ctx.memory?.cloud ?? '' });
}

/** A plan check whose estimate is explained and carries the likely and cap figures. */
export type KernelPlanCheck = Omit<PlanCheck, 'estimate'> & { estimate?: ExplainedEstimate };

/**
 * Checks a plan the user edited (R-301): untrusted JSON, validated and re-estimated by the
 * orchestrator against the plan as proposed, with the plan's own options (a test provider
 * stays refused unless the plan allowed it). The graph keeps the proposal's id and request.
 */
export function checkEdit(
  plan: Plan,
  edited: unknown,
  journal: Journal,
): { check: KernelPlanCheck; graph: TaskGraph } {
  const g = (edited ?? {}) as Partial<TaskGraph>;
  const graph: TaskGraph = {
    ...plan.graph,
    nodes: Array.isArray(g.nodes) ? g.nodes : [],
    id: plan.graph.id,
    request: plan.request,
  };
  const deps = estimateDeps(plan.setup, plan.options, journal);
  const { estimate, ...rest } = validatePlan(runnable(graph, plan), {
    ...deps,
    original: runnable(plan.graph, plan),
  });
  // A skill or agent the workspace does not have is a problem of the edit (R-502).
  const unknown = plan.extensions ? assignmentProblems(graph, plan.extensions) : [];
  const checked = unknown.length
    ? { ...rest, ok: false, problems: [...rest.problems, ...unknown] }
    : rest;
  const check = estimate
    ? { ...checked, estimate: explainEstimate(estimate, deps.router) }
    : checked;
  return { check, graph };
}

/** The plan to run: the proposal, or the user's edited version once it checks out. */
export function editedPlan(plan: Plan, edited: unknown, journal: Journal): Plan {
  const { check, graph } = checkEdit(plan, edited, journal);
  if (!check.ok || !check.estimate) {
    throw new KernelError('invalid', `the edited plan cannot run: ${check.problems.join('; ')}`);
  }
  const accuracy = plan.estimate.accuracy;
  const estimate = accuracy ? { ...check.estimate, accuracy } : check.estimate;
  return { ...plan, graph, estimate, edits: check.changes };
}
