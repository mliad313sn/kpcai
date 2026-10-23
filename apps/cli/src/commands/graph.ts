import type { GraphResult, TaskGraph } from '@kernelpai/core';
import { Governor, JournalLedger } from '@kernelpai/budget';
import type { Journal } from '@kernelpai/journal';
import { GraphRunner, estimateGraph, type GraphEstimate } from '@kernelpai/orchestrator';
import { createToolBus } from '@kernelpai/tools';
import { budgetLimits, formatMoney, money, type Money } from '../config.js';
import { kpaiHome, openJournal } from '../context.js';
import { applyPatches } from '../graph/apply.js';
import { renderEvent, renderGraphPlan, renderOutputs } from '../graph/render.js';
import { graphSetup, plannerFor, type GraphOptions, type GraphSetup } from '../graph/setup.js';
import type { Io } from '../io.js';
import { workspaceProblem } from '../graph/workspace.js';
import { BudgetGate } from './run-exec.js';

interface Planned {
  graph: TaskGraph;
  est: GraphEstimate;
  setup: GraphSetup;
  m: Money;
}

async function planGraph(
  io: Io,
  o: GraphOptions,
  journal: Journal,
  sessionId: string,
): Promise<Planned> {
  const setup = await graphSetup(io, o, journal);
  const m = money(io.env);
  if (o.planner === 'model') io.err('planning with a model: this is a paid call, budget-checked\n');
  const gate = new BudgetGate(io, journal, { sessionId, nodeId: 'planner', m }, o);
  const planner = plannerFor(o, setup, journal, sessionId, (c, l) => gate.allow(c, l));
  const graph = await planner.plan(o.request, { root: io.cwd });
  const est = estimateGraph(graph, {
    router: setup.router,
    candidates: setup.candidates,
    constraints: setup.constraints,
    allowSameProvider: o.allowSameProvider === true,
  });
  return { graph, est, setup, m };
}

/** `kpai plan "request"`: the graph, who would do what, and the cost range. Runs nothing. */
export async function planCommand(io: Io, o: GraphOptions): Promise<number> {
  const journal = openJournal(io.env, o.db);
  try {
    const sessionId = journal.startSession(`plan: ${o.request.slice(0, 74)}`, io.cwd);
    const p = await planGraph(io, o, journal, sessionId);
    io.out(renderGraphPlan(p.graph, p.est, p.m));
    return p.est.complete ? 0 : 1;
  } finally {
    journal.close();
  }
}

/** `kpai do "request"`: plan → estimate → budget → run the graph live → outputs → patches. */
export async function doCommand(io: Io, o: GraphOptions): Promise<number> {
  const journal = openJournal(io.env, o.db);
  try {
    const sessionId = o.newSession
      ? journal.startSession(o.request.slice(0, 80), io.cwd)
      : (journal.resumableSession(io.cwd, 30 * 60_000, new Date())?.id ??
        journal.startSession(o.request.slice(0, 80), io.cwd));
    const p = await planGraph(io, o, journal, sessionId);
    io.err(renderGraphPlan(p.graph, p.est, p.m));
    journal.append({
      sessionId,
      type: 'routing',
      nodeId: p.graph.id,
      payload: { plan: p.graph, estimate: p.est },
    });
    const rootProblem = workspaceProblem(io.cwd);
    if (rootProblem) {
      io.err(`not run — ${rootProblem}\n`);
      return 2;
    }
    if (!p.est.complete) {
      io.err('not run — some nodes cannot be routed (see the plan above)\n');
      return 1;
    }
    if (!(await graphBudget(io, journal, sessionId, p, o))) return 4;
    const result = await runGraph(io, journal, sessionId, p, o);
    io.out(renderOutputs(p.graph, result));
    const cancelled = Object.values(result.states).some((st) => st === 'cancelled');
    const applied = await applyPatches(io, journal, sessionId, p.graph, result, {
      ...o,
      cancelled,
    });
    io.err(`session ${sessionId.slice(0, 8)} · ${formatMoney(result.costUsd, p.m)} · ${applied}\n`);
    return result.ok ? 0 : 1;
  } finally {
    journal.close();
  }
}

/** Principle 6 on the whole graph before anything runs (each step is gated again later). */
async function graphBudget(
  io: Io,
  journal: Journal,
  sessionId: string,
  p: Planned,
  o: GraphOptions,
): Promise<boolean> {
  const governor = new Governor(budgetLimits(io.env), new JournalLedger(journal));
  const v = governor.check(p.est.totalUsd, { sessionId, project: io.cwd, now: new Date() });
  if (v.action === 'allow') return true;
  const why =
    v.action === 'block'
      ? `graph blocked by ${v.scope} budget: ${formatMoney(v.projectedUsd, p.m)} > ${formatMoney(v.limitUsd, p.m)}`
      : `graph estimate up to ${formatMoney(p.est.totalUsd, p.m)} is above your confirmation threshold`;
  if (v.action === 'block' && !o.overBudget) {
    io.err(`not run — ${why}. Use --over-budget, -p economy, or a smaller request\n`);
  } else if (o.yes || o.overBudget || (await io.confirm(`${why}. Continue?`))) {
    journal.append({
      sessionId,
      type: 'intervention',
      payload: { action: `graph accepted: ${why}` },
    });
    return true;
  }
  journal.append({
    sessionId,
    type: 'intervention',
    payload: { action: `graph not run: ${why}`, verdict: v },
  });
  return false;
}

async function runGraph(
  io: Io,
  journal: Journal,
  sessionId: string,
  p: Planned,
  o: GraphOptions,
): Promise<GraphResult> {
  const { bus, mcpErrors, policyError } = await createToolBus({
    kpaiHome: kpaiHome(io.env),
    journal,
    env: io.env,
  });
  for (const e of mcpErrors) io.err(`  – mcp ${e.server}: ${e.message}\n`);
  if (policyError) io.err(`  – policy.json ignored (defaults apply): ${policyError}\n`);
  const gate = new BudgetGate(io, journal, { sessionId, nodeId: p.graph.id, m: p.m }, o);
  const ctl = new AbortController();
  const unregister = io.onInterrupt(() => {
    journal.append({ sessionId, type: 'intervention', payload: { action: 'cancel graph' } });
    ctl.abort();
  });
  try {
    const runner = new GraphRunner({
      // The user accepted this total before the run; going beyond it asks again (P2-F9).
      maxGraphUsd: p.est.totalUsd,
      router: p.setup.router,
      candidates: p.setup.candidates,
      constraints: p.setup.constraints,
      resolve: (ref) => p.setup.registry.get(ref.provider),
      journal,
      sessionId,
      budget: (c, label) => gate.allow(c, label),
      tools: bus,
      confirm: (q) => io.confirm(q),
      root: io.cwd,
      allowSameProvider: o.allowSameProvider === true,
      onEvent: (e) => {
        const line = renderEvent(e, p.m);
        if (line) io.err(line);
      },
    });
    return await runner.run(p.graph, { signal: ctl.signal });
  } finally {
    unregister();
    await bus.close();
  }
}
