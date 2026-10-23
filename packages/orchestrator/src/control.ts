import { refToString, type ModelRef, type NodeState, type ScoredCandidate } from '@kernelpai/core';
import { estimateGraph, type EstimateDeps, type NodeEstimate } from './estimate.js';
import { routePinned, sameRef } from './routing.js';
import { nodeOf, replaceNode, servedProviders, wake, type Run } from './run-state.js';
import type { StepRunner } from './step.js';
import type { ControlAction, PlannedNode, Reroute, RunControlEvent } from './types.js';

export type ControlOutcome = { ok: true } | { ok: false; reason: string };

export interface RunStatus {
  active: boolean;
  paused: boolean;
  states: Record<string, NodeState>;
  /** Models chosen by the user (edited plan or redirect), by node id. */
  models: Record<string, ModelRef>;
}

/**
 * Steering of a live graph run (principle 4, R-304), for the kernel service. Every action
 * is journaled as an `intervention` (refusals too) and reported on `onControl`; node state
 * changes go through `onEvent` as `GraphEvent`s. Actions on no active run are refused.
 */
export interface RunControl {
  /** Stops scheduling new nodes; nodes in flight finish. */
  pause(): ControlOutcome;
  resume(): ControlOutcome;
  /** Cancels the run (same effect as aborting the run's signal). */
  cancel(): ControlOutcome;
  /**
   * Moves a pending or running node's first step to `to`. A running attempt is cancelled
   * (its partial work and cost are kept in the node's result) and the node reruns on `to`.
   * Refused when the node is finished, the model is unknown, principle 2 cannot be met
   * (later roles such as the critic are re-routed when they can be), or the budget hook /
   * `maxGraphUsd` says no.
   */
  redirect(nodeId: string, to: ModelRef): Promise<ControlOutcome>;
  /** Appends a human instruction to a pending node's request (user input, not quoted). */
  addInstruction(nodeId: string, text: string): ControlOutcome;
  status(): RunStatus;
}

export const MAX_INSTRUCTION_CHARS = 10_000;

const usd = (n: number): string => `$${Number(n.toPrecision(3))}`;
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const LIVE: ReadonlySet<NodeState | undefined> = new Set(['pending', 'running']);

interface Replan {
  before: NodeEstimate | undefined;
  after: NodeEstimate;
  reroutes: Reroute[];
  /** Spent so far plus the estimate of every node still to finish. */
  projectedUsd: number;
}

export class RunController implements RunControl {
  run: Run | undefined;

  constructor(private readonly s: StepRunner) {}

  pause(): ControlOutcome {
    const r = this.run;
    const why = !r
      ? 'no active run'
      : r.signal.aborted
        ? 'run cancelled'
        : r.paused
          ? 'already paused'
          : undefined;
    if (why || !r) return this.refuse('pause', why ?? 'no active run');
    r.paused = true;
    const inFlight = r.graph.nodes.filter((n) => r.states[n.id] === 'running').map((n) => n.id);
    this.s.intervention(undefined, { action: 'pause', inFlight });
    this.emit({ type: 'run_paused', inFlight });
    return { ok: true };
  }

  resume(): ControlOutcome {
    const r = this.run;
    if (!r || !r.paused) return this.refuse('resume', r ? 'not paused' : 'no active run');
    r.paused = false;
    this.s.intervention(undefined, { action: 'resume' });
    this.emit({ type: 'run_resumed' });
    wake(r);
    return { ok: true };
  }

  cancel(): ControlOutcome {
    const r = this.run;
    if (!r || r.signal.aborted)
      return this.refuse('cancel', r ? 'already cancelled' : 'no active run');
    this.s.intervention(undefined, { action: 'cancel' });
    this.emit({ type: 'run_cancelled' });
    r.cancel.abort();
    return { ok: true };
  }

  addInstruction(nodeId: string, text: string): ControlOutcome {
    const r = this.run;
    const node = r && nodeOf(r, nodeId);
    const clean = typeof text === 'string' ? text.trim() : '';
    const why = !r
      ? 'no active run'
      : !node
        ? `unknown node "${nodeId}"`
        : r.states[nodeId] !== 'pending'
          ? `node "${nodeId}" is ${r.states[nodeId]}; instructions go to pending nodes`
          : clean === ''
            ? 'empty instruction'
            : clean.length > MAX_INSTRUCTION_CHARS
              ? `instruction longer than ${MAX_INSTRUCTION_CHARS} characters`
              : undefined;
    if (why || !r || !node) return this.refuse('instruction', why ?? 'no active run', nodeId);
    replaceNode(r, withInstruction(node, clean));
    this.s.intervention(nodeId, { action: 'instruction added', text: clean });
    this.emit({ type: 'instruction_added', nodeId, text: clean });
    return { ok: true };
  }

  async redirect(nodeId: string, to: ModelRef): Promise<ControlOutcome> {
    const pre = this.redirectable(nodeId, to);
    if (pre) return this.refuse('redirect', pre, nodeId);
    const r = this.run as Run;
    const plan = this.replan(r, nodeId, to);
    if ('error' in plan) return this.refuse('redirect', plan.error, nodeId);
    const budget = await this.budget(r, nodeId, to, plan);
    if (budget) return this.refuse('redirect', budget, nodeId);
    // The hook may have waited for a human: the node can have finished meanwhile.
    const late = this.redirectable(nodeId, to);
    if (late) return this.refuse('redirect', late, nodeId);
    this.apply(r, nodeId, to, plan);
    return { ok: true };
  }

  status(): RunStatus {
    const r = this.run;
    const models: Record<string, ModelRef> = {};
    for (const n of r?.graph.nodes ?? []) if (n.model) models[n.id] = n.model;
    return {
      active: r !== undefined,
      paused: r?.paused ?? false,
      states: { ...r?.states },
      models,
    };
  }

  private redirectable(nodeId: string, to: ModelRef): string | undefined {
    const r = this.run;
    if (!r) return 'no active run';
    if (r.signal.aborted) return 'run cancelled';
    if (!nodeOf(r, nodeId)) return `unknown node "${nodeId}"`;
    const state = r.states[nodeId];
    if (!LIVE.has(state)) return `node "${nodeId}" is ${state}; finished work is kept`;
    const known = this.s.o.candidates.some((c) => sameRef(c.ref, to));
    return known ? undefined : `model ${refToString(to)} is not available`;
  }

  /** Re-estimates the graph with the node on `to`: diversity (principle 2) and cost. */
  private replan(r: Run, nodeId: string, to: ModelRef): Replan | { error: string } {
    const deps = this.deps(r);
    const before = estimateGraph(r.graph, deps).nodes.find((n) => n.nodeId === nodeId);
    const nodes = r.graph.nodes.map((n) => (n.id === nodeId ? { ...n, model: to } : n));
    const trial = estimateGraph({ ...r.graph, nodes }, deps);
    const after = trial.nodes.find((n) => n.nodeId === nodeId) as NodeEstimate;
    if (after.error) return { error: `cannot run on ${refToString(to)}: ${after.error}` };
    const remaining = trial.nodes
      .filter((n) => LIVE.has(r.states[n.nodeId]))
      .reduce((a, n) => a + n.expectedUsd, 0);
    return {
      before,
      after,
      reroutes: reroutes(before, after),
      projectedUsd: r6(this.s.graph.spentUsd + remaining),
    };
  }

  /** The budget hook (and `maxGraphUsd`) must accept the new model; a reason when not. */
  private async budget(
    r: Run,
    nodeId: string,
    to: ModelRef,
    plan: Replan,
  ): Promise<string | undefined> {
    const node = nodeOf(r, nodeId) as PlannedNode;
    let c: ScoredCandidate;
    try {
      c = routePinned(
        this.s.o.router,
        node,
        this.s.o.candidates,
        this.s.o.constraints ?? {},
        to,
      ).chosen;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const cap = this.s.o.maxGraphUsd;
    const over = cap !== undefined && plan.projectedUsd > cap;
    const target = `redirect ${nodeId} to ${refToString(to)}`;
    const label = over
      ? `graph total: ${usd(plan.projectedUsd)} would exceed maxGraphUsd ${usd(cap)} (${target})`
      : `${target}: estimate ${usd(plan.after.expectedUsd)}`;
    if (over && !this.s.o.budget) return `budget: ${label}`;
    return (await this.s.hook(c, label)) ? undefined : `budget: ${label} not allowed`;
  }

  private apply(r: Run, nodeId: string, to: ModelRef, plan: Replan): void {
    const node = nodeOf(r, nodeId) as PlannedNode;
    const from = node.model ?? plan.before?.ref ?? null;
    replaceNode(r, { ...node, model: to });
    const restarted = r.states[nodeId] === 'running';
    if (restarted) {
      r.redirecting.add(nodeId);
      r.attempts.get(nodeId)?.abort();
    }
    this.s.intervention(nodeId, {
      action: 'redirect',
      from: from ? refToString(from) : null,
      to: refToString(to),
      restarted,
      reroutes: plan.reroutes.map(
        (x) => `${x.role}: ${refToString(x.from)} → ${refToString(x.to)}`,
      ),
      estimateUsd: plan.after.expectedUsd,
      projectedUsd: plan.projectedUsd,
    });
    this.emit({ type: 'node_redirected', nodeId, from, to, restarted, reroutes: plan.reroutes });
    wake(r);
  }

  private deps(r: Run): EstimateDeps {
    const o = this.s.o;
    return {
      router: o.router,
      candidates: o.candidates,
      ...(o.constraints ? { constraints: o.constraints } : {}),
      ...(o.voters !== undefined ? { voters: o.voters } : {}),
      ...(o.maxRevisions !== undefined ? { maxRevisions: o.maxRevisions } : {}),
      allowSameProvider: o.allowSameProvider === true,
      known: servedProviders(r),
    };
  }

  private refuse(action: ControlAction, reason: string, nodeId?: string): ControlOutcome {
    this.s.intervention(nodeId, { action: `${action} refused`, reason });
    this.emit({ type: 'control_refused', action, ...(nodeId ? { nodeId } : {}), reason });
    return { ok: false, reason };
  }

  private emit(e: RunControlEvent): void {
    try {
      this.s.o.onControl?.(e);
    } catch {
      // A broken listener never breaks the run.
    }
  }
}

/** Later roles whose model changes with the redirect (e.g. a critic moved off the author). */
function reroutes(before: NodeEstimate | undefined, after: NodeEstimate): Reroute[] {
  if (!before || before.protocol !== after.protocol) return [];
  return after.steps.slice(1).flatMap((s, i) => {
    const b = before.steps[i + 1];
    return b && b.role === s.role && !sameRef(b.ref, s.ref)
      ? [{ role: s.role, from: b.ref, to: s.ref }]
      : [];
  });
}

/** The node with the instruction appended to its last user message (its request). */
export function withInstruction(node: PlannedNode, text: string): PlannedNode {
  const note = `Instruction added by the user during the run:\n${text}`;
  const idx = node.messages.map((m) => m.role).lastIndexOf('user');
  const messages =
    idx === -1
      ? [...node.messages, { role: 'user' as const, content: note }]
      : node.messages.map((m, i) => (i === idx ? { ...m, content: `${m.content}\n\n${note}` } : m));
  return { ...node, messages };
}
