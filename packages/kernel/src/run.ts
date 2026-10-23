/** Running an approved plan: whole-graph budget, GraphRunner, patches collected at the end. */
import type { GraphResult } from '@kernelpai/core';
import { Governor, JournalLedger } from '@kernelpai/budget';
import type { Journal } from '@kernelpai/journal';
import { GraphRunner, type RunControlEvent } from '@kernelpai/orchestrator';
import { createToolBus } from '@kernelpai/tools';
import { BudgetGate, type GateHost } from './budget-gate.js';
import { budgetLimits, formatMoney, kpaiHome } from './env.js';
import { collect } from './patches.js';
import { RouterTap, UsageTap, annotate } from './routing-info.js';
import type { GraphOptions } from './setup.js';
import type { KernelHost, Plan, RunOutcome, RunState } from './types.js';

export interface ActiveRun {
  runId: string;
  plan: Plan;
  /** The plan's options with the run's own flags (yes, overBudget) on top. */
  flags: GraphOptions;
  ctl: AbortController;
  /** `starting` while the whole-graph budget is checked. */
  state: RunState | 'starting';
  runner?: GraphRunner;
  outcome?: RunOutcome;
}

export interface RunContext {
  host: KernelHost;
  journal: Journal;
  gateHost: GateHost;
  setState(run: ActiveRun, state: RunState): void;
}

/** Plan → (budget) → run → patches. Rejects only on an unexpected error. */
export async function executeRun(c: RunContext, run: ActiveRun): Promise<RunOutcome> {
  const refusal = await graphBudget(c, run);
  if (refusal) {
    c.setState(run, 'cancelled');
    return { status: 'not_run', reason: refusal };
  }
  c.setState(run, 'running');
  const result = await runGraph(c, run);
  const cancelled = Object.values(result.states).some((st) => st === 'cancelled');
  const { patches, refused } = collect(run.plan.graph, result);
  for (const r of refused) {
    c.journal.append({
      sessionId: run.plan.sessionId,
      type: 'intervention',
      nodeId: r.nodeId,
      payload: { action: 'patch refused: control characters' },
    });
  }
  c.setState(run, cancelled ? 'cancelled' : result.ok ? 'done' : 'failed');
  return { status: 'finished', result, cancelled, patches, refused };
}

/**
 * Principle 6 on the whole graph before anything runs (each step is gated again later).
 * Returns why the graph does not run, or undefined to go ahead.
 */
async function graphBudget(c: RunContext, run: ActiveRun): Promise<string | undefined> {
  const { plan: p, flags: o } = run;
  const env = c.host.env;
  const sessionId = p.sessionId;
  const governor = new Governor(budgetLimits(env), new JournalLedger(c.journal));
  const v = governor.check(p.estimate.totalUsd, {
    sessionId,
    project: c.host.cwd,
    now: new Date(),
  });
  if (v.action === 'allow') return undefined;
  const why =
    v.action === 'block'
      ? `graph blocked by ${v.scope} budget: ${formatMoney(v.projectedUsd, p.m)} > ${formatMoney(v.limitUsd, p.m)}`
      : `graph estimate up to ${formatMoney(p.estimate.totalUsd, p.m)} is above your confirmation threshold`;
  if (v.action === 'block' && !o.overBudget) {
    c.gateHost.say(`not run — ${why}. Use --over-budget, -p economy, or a smaller request\n`);
  } else if (
    o.yes ||
    o.overBudget ||
    (await c.gateHost.confirm({ kind: 'budget', question: `${why}. Continue?`, runId: run.runId }))
  ) {
    c.journal.append({
      sessionId,
      type: 'intervention',
      payload: { action: `graph accepted: ${why}` },
    });
    return undefined;
  }
  c.journal.append({
    sessionId,
    type: 'intervention',
    payload: { action: `graph not run: ${why}`, verdict: v },
  });
  return why;
}

async function runGraph(c: RunContext, run: ActiveRun): Promise<GraphResult> {
  const { plan: p, flags: o, runId } = run;
  const { bus, mcpErrors, policyError } = await createToolBus({
    kpaiHome: kpaiHome(c.host.env),
    journal: c.journal,
    env: c.host.env,
  });
  for (const e of mcpErrors) c.gateHost.say(`  – mcp ${e.server}: ${e.message}\n`);
  if (policyError) c.gateHost.say(`  – policy.json ignored (defaults apply): ${policyError}\n`);
  const gate = new BudgetGate(
    c.gateHost,
    c.journal,
    { sessionId: p.sessionId, nodeId: p.graph.id, m: p.m, runId },
    o,
  );
  const router = new RouterTap(p.setup.router);
  const usage = new UsageTap();
  try {
    run.runner = new GraphRunner({
      // The user accepted this total before the run; going beyond it asks again (P2-F9).
      maxGraphUsd: p.estimate.totalUsd,
      router,
      candidates: p.setup.candidates,
      constraints: p.setup.constraints,
      resolve: (ref) => p.setup.registry.get(ref.provider),
      journal: usage.wrap(c.journal),
      sessionId: p.sessionId,
      budget: (cand, label) => gate.allow(cand, label),
      tools: bus,
      confirm: (question) => c.gateHost.confirm({ kind: 'tool', question, runId }),
      root: c.host.cwd,
      allowSameProvider: o.allowSameProvider === true,
      onEvent: (e) => c.host.onEvent?.(runId, annotate(e, router, usage)),
      onControl: (e) => onControl(c, run, e),
    });
    return await run.runner.run(p.graph, {
      signal: run.ctl.signal,
      ...(p.edits?.length ? { edits: p.edits } : {}),
    });
  } finally {
    await bus.close();
  }
}

/** Run-level control events become run states, and are passed on as they are. */
const STATE_OF: Partial<Record<RunControlEvent['type'], RunState>> = {
  run_paused: 'paused',
  run_resumed: 'running',
  run_cancelled: 'cancelling',
};

function onControl(c: RunContext, run: ActiveRun, e: RunControlEvent): void {
  const state = STATE_OF[e.type];
  if (state) c.setState(run, state);
  c.host.onControl?.(run.runId, e);
}
