/**
 * Replay and fork at the kernel boundary (spec §3.5, R-403). A replay reruns one recorded
 * node with another model or protocol, beside the original, through the budget gate at
 * every step and under a cap estimated for that node. A fork is planned here (its estimate
 * covers only the nodes that run again) and started like any plan, so the whole-graph
 * budget check uses the band's top (D-021). A fork's graph already carries the rules and
 * memory it recorded: it is never given them again.
 */
import { randomUUID } from 'node:crypto';
import type { ModelRef, ProtocolName } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import {
  ReplayError,
  estimateGraph,
  planFork,
  readRun,
  replayNode,
  type ReplayResult,
} from '@kernelpai/orchestrator';
import type { GateHost } from './budget-gate.js';
import type { Choose } from './confirm.js';
import { money } from './env.js';
import { KernelError } from './errors.js';
import { noPacks, selectPacks, type SelectedPacks } from './packs.js';
import { estimateDeps } from './planning.js';
import { explainEstimate } from './routing-info.js';
import { NO_RULES } from './rules.js';
import { runDeps } from './run-deps.js';
import { checkScope } from './scope.js';
import { graphSetup, type GraphOptions, type GraphSetup } from './setup.js';
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

function known(journal: Journal, runId: string, nodeId: string) {
  const run = readRun(journal, runId);
  if (!run) throw new KernelError('not_found', `run ${runId} is not in the journal`);
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

async function setupOf(h: ReplayHost, o: GraphOptions): Promise<GraphSetup> {
  const { env, cwd, say } = h.gateHost;
  return graphSetup(env, say, o, h.journal(), cwd);
}

const invalid = (err: unknown): never => {
  if (err instanceof ReplayError) throw new KernelError('invalid', err.message);
  throw err;
};

export class KernelReplays {
  constructor(private readonly h: ReplayHost) {}

  /** Reruns one recorded node beside the original (which is never changed). */
  async replay(
    runId: string,
    nodeId: string,
    edit: NodeEdit = {},
    o: GraphOptions = {},
  ): Promise<ReplayResult> {
    const journal = this.h.journal();
    const run = known(journal, runId, nodeId);
    const rec = run.nodes[nodeId];
    if (!rec)
      throw new KernelError('refused', `node "${nodeId}" never finished: nothing to replay`);
    const setup = await setupOf(this.h, o);
    const m = edit.model;
    if (
      m &&
      !setup.candidates.some((c) => c.ref.provider === m.provider && c.ref.model === m.model)
    )
      throw new KernelError('invalid', `model ${m.provider}/${m.model} is not available`);
    const node = { ...rec.node, dependsOn: [], protocol: edit.protocol ?? rec.protocol };
    if (edit.model) node.model = edit.model;
    else delete node.model;
    const graph = { ...run.graph, nodes: [node] };
    const est = estimateGraph(graph, estimateDeps(setup, o, journal));
    if (!est.complete) throw new KernelError('unroutable', est.problems.join('; '));
    const plan = {
      sessionId: run.sessionId,
      graph,
      setup,
      m: money(this.h.gateHost.env),
      packs: await packsOf(this.h),
      estimate: { capUsd: est.band.highUsd },
    };
    const deps = await runDeps({
      journal,
      gateHost: this.h.gateHost,
      choose: this.h.choose,
      plan,
      flags: o,
      runId,
      root: this.h.gateHost.cwd,
    });
    try {
      const r = edit.model ? { model: edit.model } : {};
      const p = edit.protocol ? { protocol: edit.protocol } : {};
      return await replayNode(journal, runId, nodeId, { ...r, ...p }, deps.options).catch(invalid);
    } finally {
      await deps.close();
    }
  }

  /** A fork from a node of a past run, ready to start with `Kernel.startFork`. */
  async forkPlan(
    runId: string,
    nodeId: string,
    edit: NodeEdit = {},
    o: GraphOptions = {},
  ): Promise<Plan> {
    const journal = this.h.journal();
    const run = known(journal, runId, nodeId);
    const setup = await setupOf(this.h, o);
    const deps = estimateDeps(setup, o, journal);
    let fork;
    try {
      fork = planFork(journal, runId, nodeId, edit, deps);
    } catch (err) {
      return invalid(err);
    }
    const packs = await packsOf(this.h);
    const { cwd, env } = this.h.gateHost;
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
