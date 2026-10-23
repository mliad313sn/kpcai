/** Running an approved plan: whole-graph budget, GraphRunner, patches collected at the end. */
import type { GraphEvent } from '@kernelpai/core';
import { Governor, JournalLedger } from '@kernelpai/budget';
import type { Journal } from '@kernelpai/journal';
import {
  GraphRunner,
  ScopeError,
  type RunControlEvent,
  type RunResult,
} from '@kernelpai/orchestrator';
import { outputCalibration } from '@kernelpai/executor';
import { createToolBus } from '@kernelpai/tools';
import { BudgetGate, type GateHost } from './budget-gate.js';
import { budgetLimits, formatMoney, kpaiHome } from './env.js';
import { collectArtifacts } from './artifacts.js';
import { busPacks } from './packs.js';
import { collect } from './patches.js';
import { runnable } from './planning.js';
import { RouterTap, UsageTap, annotate } from './routing-info.js';
import type { GraphOptions } from './setup.js';
import type { KernelHost, Plan, RunOutcome, RunState } from './types.js';
import { isGitTree, type WorkspaceOps } from './workspace-ops.js';

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
  startedAt: string;
  /** Spent so far, from contribution events (USD). */
  costUsd: number;
  /** Last critic verdict per node. */
  verdicts: Map<string, boolean>;
  /** Isolated runs (R-307): the jail root and worktree; absent for in-place runs. */
  workRoot?: string;
  worktree?: string;
  /** The authorised scope handed to the runner (WI-S1-03), validated there. */
  scope?: unknown;
}

export interface RunContext {
  host: KernelHost;
  journal: Journal;
  gateHost: GateHost;
  ws: WorkspaceOps;
  setState(run: ActiveRun, state: RunState): void;
}

/** Plan → (budget) → run → patches. Rejects only on an unexpected error. */
export async function executeRun(c: RunContext, run: ActiveRun): Promise<RunOutcome> {
  const refusal = await graphBudget(c, run);
  if (refusal) {
    c.setState(run, 'cancelled');
    return { status: 'not_run', reason: refusal };
  }
  const notIsolated = await isolate(c, run);
  if (notIsolated) {
    c.setState(run, 'failed');
    return { status: 'not_run', reason: notIsolated };
  }
  c.setState(run, 'running');
  let result: RunResult;
  try {
    result = await runGraph(c, run);
  } catch (err) {
    // The runner refused the scope before any call, and journaled it (WI-S4-02).
    if (!(err instanceof ScopeError)) throw err;
    c.setState(run, 'failed');
    return { status: 'not_run', reason: err.message };
  }
  const cancelled = Object.values(result.states).some((st) => st === 'cancelled');
  const { patches, refused } = collect(run.plan.graph, result);
  const sessionId = run.plan.sessionId;
  const ids = { runId: run.runId, sessionId };
  const arts = collectArtifacts(run.plan.graph, result, ids);
  for (const r of refused) {
    c.journal.append({
      sessionId,
      type: 'intervention',
      nodeId: r.nodeId,
      payload: { action: 'patch refused: control characters' },
    });
  }
  for (const r of arts.refused) {
    const payload = { action: 'artifact refused', path: r.path, reason: r.reason };
    c.journal.append({ sessionId, type: 'intervention', nodeId: r.nodeId, payload });
  }
  c.setState(run, cancelled ? 'cancelled' : result.ok ? 'done' : 'failed');
  return {
    status: 'finished',
    result,
    cancelled,
    patches,
    refused,
    artifacts: arts.artifacts,
    refusedArtifacts: arts.refused,
    ...(run.worktree ? { worktree: run.worktree } : {}),
  };
}

/**
 * R-307: an isolated run works in its own worktree. `auto` falls back to running in place
 * outside git (journaled); `true` without git refuses the run. Returns why it cannot run.
 */
async function isolate(c: RunContext, run: ActiveRun): Promise<string | undefined> {
  const want = run.flags.isolated;
  if (!want) return undefined;
  const sessionId = run.plan.sessionId;
  if (want === 'auto' && !(await isGitTree(c.host.cwd))) {
    const payload = { action: 'run in place', runId: run.runId, reason: 'not a git repository' };
    c.journal.append({ sessionId, type: 'intervention', payload });
    return undefined;
  }
  try {
    const wt = await c.ws.createWorktree(run.runId);
    run.workRoot = wt.root;
    run.worktree = wt.path;
    const payload = { action: 'worktree created', runId: run.runId, path: wt.path };
    c.journal.append({ sessionId, type: 'intervention', payload });
    return undefined;
  } catch (err) {
    const why = `an isolated run needs a git worktree: ${err instanceof Error ? err.message : String(err)}`;
    c.journal.append({
      sessionId,
      type: 'intervention',
      payload: { action: 'run not isolated', reason: why },
    });
    return why;
  }
}

/** Live cost and critic verdicts for the runs manager view. */
function track(run: ActiveRun, e: GraphEvent): void {
  if (e.type !== 'contribution') return;
  run.costUsd += e.contribution.costUsd;
  if (e.contribution.verdict) run.verdicts.set(e.nodeId, e.contribution.verdict.approve);
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
  // D-021: the figure approved and checked is the cap (the band's top), not the likely cost.
  const { capUsd, expectedUsd } = p.estimate;
  const v = governor.check(capUsd, { sessionId, project: c.host.cwd, now: new Date() });
  if (v.action === 'allow') return undefined;
  const likely = `likely ${formatMoney(expectedUsd, p.m)}`;
  const why =
    v.action === 'block'
      ? `graph blocked by ${v.scope} budget: ${formatMoney(v.projectedUsd, p.m)} > ${formatMoney(v.limitUsd, p.m)} (cap; ${likely})`
      : `graph estimate up to ${formatMoney(capUsd, p.m)} (cap; ${likely}) is above your confirmation threshold`;
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

async function runGraph(c: RunContext, run: ActiveRun): Promise<RunResult> {
  const { plan: p, flags: o, runId } = run;
  const { bus, mcpErrors, policyError } = await createToolBus({
    kpaiHome: kpaiHome(c.host.env),
    journal: c.journal,
    env: c.host.env,
    // The run's domain packs: additions always, approved relaxations journaled (D-020).
    packs: busPacks(p.packs, p.sessionId),
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
      // The user accepted this cap (the band's top, D-021); going beyond it asks again (P2-F9).
      maxGraphUsd: p.estimate.capUsd,
      router,
      candidates: p.setup.candidates,
      constraints: p.setup.constraints,
      resolve: (ref) => p.setup.registry.get(ref.provider),
      // Per-call estimates use the same calibrated output sizes as routing (S8 finding).
      executor: { expectedOutput: outputCalibration(c.journal) },
      journal: usage.wrap(c.journal),
      sessionId: p.sessionId,
      budget: (cand, label) => gate.allow(cand, label),
      tools: bus,
      confirm: (question) => c.gateHost.confirm({ kind: 'tool', question, runId }),
      // The run's jail: its worktree when isolated (R-307).
      root: run.workRoot ?? c.host.cwd,
      allowSameProvider: o.allowSameProvider === true,
      onEvent: (e) => {
        track(run, e);
        c.host.onEvent?.(runId, annotate(e, router, usage));
      },
      onControl: (e) => onControl(c, run, e),
    });
    // Every node gets the repository rules (untrusted) and the output note (R-306, D-019).
    return await run.runner.run(runnable(p.graph, p.rules), {
      signal: run.ctl.signal,
      ...(p.edits?.length ? { edits: p.edits } : {}),
      // Packs and scope: the runner refuses without a valid scope and journals it (S4).
      packs: p.packs.selected,
      ...(run.scope !== undefined ? { scope: run.scope } : {}),
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
