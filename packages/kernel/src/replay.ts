/**
 * Replay and fork at the kernel boundary (spec §3.5, R-403). A replay reruns one recorded
 * node with another model or protocol, beside the original. It is planned first (its
 * estimate shown: likely and cap, D-021), then started: the cap is checked against the
 * budget like a run's, every step goes through the budget gate, the authorised scope of
 * the current packs is checked now (P4-F6), and it can be cancelled by its id (P4-F5).
 * A fork is planned here (its estimate covers only the nodes that run again) and started
 * like any plan. Both hold the original run's routing constraints as a floor (P4-F2) and
 * only accept a run of this project (P4-F4). A fork's graph already carries the rules and
 * memory it recorded: it is never given them again.
 */
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ModelRef, ProtocolName, TaskGraph } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import {
  ReplayError,
  ScopeError,
  estimateGraph,
  planFork,
  readRun,
  replayNode,
  type RecordedRun,
  type ReplayResult,
} from '@kernelpai/orchestrator';
import { gatherScope } from './authorise.js';
import type { GateHost } from './budget-gate.js';
import { capCheck } from './cap-check.js';
import type { Choose } from './confirm.js';
import { money, type Money } from './env.js';
import { KernelError } from './errors.js';
import { noPacks, selectPacks, type SelectedPacks } from './packs.js';
import { estimateDeps } from './planning.js';
import { explainEstimate, type ExplainedEstimate } from './routing-info.js';
import { runFlags } from './run-record.js';
import { NO_RULES } from './rules.js';
import { runDeps } from './run-deps.js';
import { checkScope, type ScopeCheck } from './scope.js';
import {
  graphSetup,
  routingFloor,
  routingRecord,
  type GraphOptions,
  type GraphSetup,
} from './setup.js';
import type { Plan } from './types.js';

export interface ReplayHost {
  gateHost: GateHost;
  choose: Choose;
  journal(): Journal;
  /** A session for the fork's run (journaled apart from the parent's). */
  session(title: string): string;
}

export interface NodeEdit {
  model?: ModelRef;
  protocol?: ProtocolName;
  /** Fork only: added to the node's request like a mid-run instruction. */
  instruction?: string;
}

/** A replay the user can see before anything is spent (P4-F5). */
export interface ReplayPlan {
  /** Also the replay's id once started: cancel it with this id. */
  planId: string;
  runId: string;
  nodeId: string;
  /** The run's session (of this project, P4-F4): the replay is journaled there. */
  sessionId: string;
  edit: NodeEdit;
  /** The options as given, held to the run's routing floor (P4-F2). */
  options: GraphOptions;
  /** The one node that runs again. */
  graph: TaskGraph;
  setup: GraphSetup;
  m: Money;
  packs: SelectedPacks;
  /** The authorised scope the current packs require, checked now (P4-F6). */
  scope: ScopeCheck;
  /** Likely and cap (the band's top) of the replayed node (D-021). */
  estimate: ExplainedEstimate;
}

/** Run-time flags of a replay; waivers come from the plan, never from here (P3-F6). */
export interface ReplayFlags {
  yes?: boolean | undefined;
  overBudget?: boolean | undefined;
  /** The human already accepted this plan's likely and cap (the CLI asked): not asked again. */
  accepted?: boolean | undefined;
}

export interface ReplayHandle {
  replayId: string;
  runId: string;
  nodeId: string;
  sessionId: string;
  done: Promise<ReplayResult>;
}

const KEEP_PLANS = 32;

const real = (p: string): Promise<string> => realpath(p).catch(() => resolve(p));

/** The run, if it was journaled by a session of this project (P4-F4); else not found. */
async function known(journal: Journal, cwd: string, runId: string, nodeId: string) {
  const run = readRun(journal, runId);
  const session = run ? journal.findSession(run.sessionId) : undefined;
  const here = session !== undefined && (await real(session.cwd)) === (await real(cwd));
  if (!run || !here)
    throw new KernelError('not_found', `run ${runId} is not in the journal of this project`);
  if (!run.graph.nodes.some((n) => n.id === nodeId))
    throw new KernelError('not_found', `run ${runId} has no node "${nodeId}"`);
  return run;
}

async function packsOf(h: ReplayHost): Promise<SelectedPacks> {
  const { env, cwd } = h.gateHost;
  return selectPacks(env, cwd).catch((err: unknown) =>
    noPacks(env, `domain packs not read: ${err instanceof Error ? err.message : String(err)}`),
  );
}

/**
 * The setup of a replay or fork. `policy` false drops the review policy: a replay reruns
 * one node as asked (it never applies the policy, so neither does its estimate), and a
 * human's explicit protocol for a fork wins over it (ADR-0030).
 */
async function setupOf(h: ReplayHost, o: GraphOptions, policy: boolean): Promise<GraphSetup> {
  const { env, cwd, say } = h.gateHost;
  const s = await graphSetup(env, say, o, h.journal(), cwd);
  if (policy || !s.reviewPolicy) return s;
  const rest = { ...s };
  delete rest.reviewPolicy;
  return rest;
}

const invalid = (err: unknown): never => {
  if (err instanceof ReplayError) throw new KernelError('invalid', err.message);
  if (err instanceof ScopeError) throw new KernelError('refused', err.message);
  throw err;
};

/** The node to replay, as recorded, with the edit; checked against the candidates. */
function replayGraph(run: RecordedRun, nodeId: string, edit: NodeEdit, setup: GraphSetup) {
  const rec = run.nodes[nodeId];
  if (!rec) throw new KernelError('refused', `node "${nodeId}" never finished: nothing to replay`);
  const m = edit.model;
  if (m && !setup.candidates.some((c) => c.ref.provider === m.provider && c.ref.model === m.model))
    throw new KernelError('invalid', `model ${m.provider}/${m.model} is not available`);
  const node = { ...rec.node, dependsOn: [], protocol: edit.protocol ?? rec.protocol };
  if (edit.model) node.model = edit.model;
  else delete node.model;
  return { ...run.graph, nodes: [node] };
}

export class KernelReplays {
  private readonly plans = new Map<string, ReplayPlan>();
  private readonly live = new Map<
    string,
    { ctl: AbortController; done: Promise<unknown>; sessionId: string }
  >();

  constructor(private readonly h: ReplayHost) {}

  /** Plans a replay of one recorded node: what it reruns and what it may cost. Spends nothing. */
  async plan(
    runId: string,
    nodeId: string,
    edit: NodeEdit = {},
    given: GraphOptions = {},
  ): Promise<ReplayPlan> {
    const journal = this.h.journal();
    const { cwd, env } = this.h.gateHost;
    const run = await known(journal, cwd, runId, nodeId);
    const o = routingFloor(given, run.routing);
    const setup = await setupOf(this.h, o, false);
    const graph = replayGraph(run, nodeId, edit, setup);
    const deps = estimateDeps(setup, o, journal);
    const est = estimateGraph(graph, deps);
    if (!est.complete) throw new KernelError('unroutable', est.problems.join('; '));
    const packs = await packsOf(this.h);
    const plan: ReplayPlan = {
      planId: randomUUID(),
      runId,
      nodeId,
      sessionId: run.sessionId,
      edit,
      options: o,
      graph,
      setup,
      m: money(env),
      packs,
      scope: await checkScope(packs.selected, cwd, o.scope, graph.nodes),
      estimate: explainEstimate(est, deps.router),
    };
    this.plans.set(plan.planId, plan);
    while (this.plans.size > KEEP_PLANS) this.plans.delete(this.plans.keys().next().value!);
    return plan;
  }

  /** Starts a planned replay once; `done` settles with the side-by-side result. */
  start(planId: string, flags: ReplayFlags = {}): ReplayHandle {
    const plan = this.plans.get(planId);
    if (!plan) throw new KernelError('not_found', `no replay plan ${planId} (plan it again)`);
    this.plans.delete(planId);
    const ctl = new AbortController();
    const done = this.execute(plan, flags, ctl.signal);
    const entry = { ctl, done: done.catch(() => undefined), sessionId: plan.sessionId };
    this.live.set(planId, entry);
    void entry.done.then(() => this.live.delete(planId));
    const { runId, nodeId, sessionId } = plan;
    return { replayId: planId, runId, nodeId, sessionId, done };
  }

  /** Cancels a live replay (journaled); undefined when `id` is not a replay this kernel runs. */
  cancel(id: string): boolean | undefined {
    const r = this.live.get(id);
    if (!r) return undefined;
    if (r.ctl.signal.aborted) return false;
    const payload = { action: 'replay cancelled', replayId: id };
    this.h.journal().append({ sessionId: r.sessionId, type: 'intervention', payload });
    r.ctl.abort();
    return true;
  }

  /** True while a cancelled replay winds down: its questions are void. */
  cancelling(id: string | undefined): boolean {
    return id !== undefined && this.live.get(id)?.ctl.signal.aborted === true;
  }

  /** Cancels every live replay and waits for them. */
  async close(onCancel: (id: string) => void): Promise<void> {
    for (const [id, r] of this.live) {
      r.ctl.abort();
      onCancel(id);
    }
    await Promise.allSettled([...this.live.values()].map((r) => r.done));
  }

  /** Scope (current packs, now), cap (band top), then the node, cancellable throughout. */
  private async execute(p: ReplayPlan, f: ReplayFlags, signal: AbortSignal) {
    const journal = this.h.journal();
    const host = this.h.gateHost;
    const scope = await gatherScope(journal, host.confirm, p);
    const flags = runFlags(p.options, { yes: f.yes, overBudget: f.overBudget });
    const { capUsd, expectedUsd } = p.estimate;
    const capFlags = {
      yes: flags.yes === true || f.accepted === true,
      overBudget: flags.overBudget,
    };
    const ids = { sessionId: p.sessionId, runId: p.planId, m: p.m };
    const why = await capCheck(host, journal, {
      what: 'replay',
      ...ids,
      capUsd,
      expectedUsd,
      flags: capFlags,
    });
    if (why) throw new KernelError('budget', `replay not run — ${why}`);
    if (signal.aborted) throw new KernelError('refused', 'replay cancelled before it started');
    const deps = await runDeps({
      journal,
      gateHost: host,
      choose: this.h.choose,
      plan: p,
      flags,
      runId: p.planId,
      root: host.cwd,
    });
    try {
      const run = {
        ...deps.options,
        signal,
        packs: p.packs.selected,
        ...(scope !== undefined ? { scope } : {}),
        replayId: p.planId,
        routing: routingRecord(host.env, p.options),
      };
      return await replayNode(journal, p.runId, p.nodeId, nodeEditOf(p.edit), run).catch(invalid);
    } finally {
      await deps.close();
    }
  }

  /** A fork from a node of a past run, ready to start with `Kernel.startFork`. */
  async forkPlan(
    runId: string,
    nodeId: string,
    edit: NodeEdit = {},
    given: GraphOptions = {},
  ): Promise<Plan> {
    const journal = this.h.journal();
    const { cwd, env } = this.h.gateHost;
    const run = await known(journal, cwd, runId, nodeId);
    const o = routingFloor(given, run.routing);
    const setup = await setupOf(this.h, o, edit.protocol === undefined);
    const deps = estimateDeps(setup, o, journal);
    let fork;
    try {
      fork = planFork(journal, runId, nodeId, edit, deps);
    } catch (err) {
      return invalid(err);
    }
    const packs = await packsOf(this.h);
    return {
      planId: randomUUID(),
      sessionId: this.h.session(`fork of ${runId.slice(0, 8)} at ${nodeId}`),
      request: run.graph.request,
      graph: fork.graph,
      estimate: explainEstimate(fork.estimate, deps.router),
      options: o,
      setup,
      m: money(env),
      rules: NO_RULES,
      packs,
      scope: await checkScope(packs.selected, cwd, o.scope, fork.graph.nodes),
      fork,
    };
  }
}

/** The replay's edit for the orchestrator (no fork-only instruction). */
function nodeEditOf(edit: NodeEdit): { model?: ModelRef; protocol?: ProtocolName } {
  return {
    ...(edit.model ? { model: edit.model } : {}),
    ...(edit.protocol ? { protocol: edit.protocol } : {}),
  };
}
