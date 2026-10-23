import {
  refToString,
  type Contribution,
  type GraphEvent,
  type GraphNode,
  type ModelRef,
  type RoutingDecision,
  type ScoredCandidate,
  type TaskNode,
} from '@kernelpai/core';
import { FallbackExecutor } from '@kernelpai/executor';
import { stepBand } from './band.js';
import { GraphBudget } from './graph-budget.js';
import { NodeBudgets, type NodeHold } from './node-budget.js';
import { stepMessages } from './prompts.js';
import { preferRef, routeDiverse, sameRef, type Routed } from './routing.js';
import { executeWithTools, type LoopResult } from './tool-loop.js';
import {
  OrchestrationError,
  type NodeRun,
  type OrchestratorOptions,
  type PlannedNode,
  type StepFailed,
  type StepOutcome,
  type StepSpec,
} from './types.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * One routed model step of a protocol: route (with diversity), journal the routing with
 * its role, gate the spend, execute with fallback and the tool loop, record the contribution.
 */
export class StepRunner {
  readonly executor: FallbackExecutor;
  /** Cumulative spend of the current graph run against `maxGraphUsd`. */
  readonly graph: GraphBudget;
  /** Per-node spend of the current graph run against each node's `budgetUsd`. */
  readonly nodes: NodeBudgets;

  constructor(readonly o: OrchestratorOptions) {
    this.executor = new FallbackExecutor(o.resolve, o.journal, o.executor);
    const ask = o.budget && ((c: ScoredCandidate, l: string) => this.hook(c, l));
    this.graph = new GraphBudget(o.maxGraphUsd, ask, o.journal, o.sessionId);
    this.nodes = new NodeBudgets(ask, o.journal, o.sessionId);
  }

  emit(event: GraphEvent): void {
    try {
      this.o.onEvent?.(event);
    } catch {
      // A broken listener never breaks the run.
    }
  }

  /**
   * Spend gate of every model call: the graph cap first (`maxGraphUsd`), then the node's
   * cap (`budgetUsd`, against this call's band top), then the budget hook. A throw counts
   * as a refusal (as in the executor). Returns why the call must not run, else undefined.
   */
  async refusal(
    c: ScoredCandidate,
    label: string,
    run: NodeRun,
    own?: NodeHold,
  ): Promise<string | undefined> {
    if (!(await this.graph.check(c, label, run.node.id))) return `budget: ${label} not allowed`;
    const node = await this.nodes.check(run, c, this.topUsd(c), label, own);
    if (node) return node;
    return (await this.hook(c, label)) ? undefined : `budget: ${label} not allowed`;
  }

  async allow(c: ScoredCandidate, label: string, run: NodeRun, own?: NodeHold): Promise<boolean> {
    return (await this.refusal(c, label, run, own)) === undefined;
  }

  /**
   * Band top of one call of `c` (D-021: the worst plausible cost, not the average), without
   * tool rounds (each round is gated on its own). Unknown card: the full output cap's cost.
   */
  topUsd(c: ScoredCandidate): number {
    const card = this.o.candidates.find((k) => sameRef(k.ref, c.ref))?.card;
    if (!card) return Math.max(c.estimate.expectedCostUsd, c.estimate.maxCostUsd);
    return stepBand(card, c.estimate, { min: 1, max: 1 }, undefined).perCallHighUsd;
  }

  /** The budget hook alone (no graph cap); no hook allows, a throw refuses. */
  async hook(c: ScoredCandidate, label: string): Promise<boolean> {
    if (!this.o.budget) return true;
    try {
      return (await this.o.budget(c, label)) !== false;
    } catch {
      return false;
    }
  }

  /** Journals a control or protocol decision; run-level actions have no node id. */
  intervention(nodeId: string | undefined, payload: Record<string, unknown>): void {
    this.o.journal.append({
      sessionId: this.o.sessionId,
      type: 'intervention',
      ...(nodeId !== undefined ? { nodeId } : {}),
      payload,
    });
  }

  /** Records a contribution on the node and emits it. */
  record(run: NodeRun, contribution: Contribution): void {
    run.contributions.push(contribution);
    this.emit({ type: 'contribution', nodeId: run.node.id, contribution });
  }

  async run(
    run: NodeRun,
    spec: StepSpec & { decision?: RoutingDecision; deferRecord?: boolean },
  ): Promise<StepOutcome> {
    if (run.signal?.aborted) return failed('cancelled before start', 0, true);
    const stepNode: GraphNode = {
      ...run.node,
      type: spec.type ?? run.node.type,
      messages: stepMessages(run.node, spec.prompt),
    };
    // The user's model (principle 4) serves the node's first routed step only.
    const pin = spec.decision ? undefined : run.pin;
    if (pin) run.pin = undefined;
    let decision: RoutingDecision;
    try {
      decision = spec.decision ?? this.decide(stepNode, spec, pin);
    } catch (err) {
      const f = failed(errorText(err), 0, false);
      return err instanceof OrchestrationError ? { ...f, diversity: true } : f;
    }
    const label = `${spec.role} on ${run.node.id}: ${refToString(decision.chosen.ref)}`;
    const refused = await this.refusal(decision.chosen, label, run);
    if (refused) {
      this.intervention(run.node.id, { action: 'step blocked by budget', role: spec.role, label });
      return failed(refused, 0, false);
    }
    const loop = await this.execute(run, spec, stepNode, decision);
    if (!loop.ok) {
      if (loop.text && loop.ref) {
        this.record(run, {
          role: spec.role,
          ref: loop.ref,
          text: loop.text,
          costUsd: loop.costUsd,
        });
      }
      return failed(loop.error, loop.costUsd, loop.cancelled);
    }
    const contribution: Contribution = {
      role: spec.role,
      ref: loop.ref,
      text: loop.text,
      costUsd: loop.costUsd,
    };
    if (!spec.deferRecord) this.record(run, contribution);
    return { ...loop, decision, contribution };
  }

  /**
   * Runs the step with its claims on the graph and node budgets held; the loop adds each
   * call's cost to `run.costUsd` as it returns (node cap, P3-F5).
   */
  private execute(
    run: NodeRun,
    spec: StepSpec,
    stepNode: GraphNode,
    decision: RoutingDecision,
  ): Promise<LoopResult> {
    const release = this.graph.reserve(decision.chosen.estimate.expectedCostUsd);
    const hold = this.nodes.hold(run.node.id, this.topUsd(decision.chosen));
    return executeWithTools(this, run, spec, stepNode, decision, hold).finally(() => {
      release();
      hold.release();
    });
  }

  private decide(node: TaskNode, spec: StepSpec, pin: ModelRef | undefined): RoutingDecision {
    const routed = routeDiverse(this.o, node, spec, pin);
    const decision = spec.prefer ? preferRef(routed.decision, spec.prefer) : routed.decision;
    this.journalRouting(node, spec, { ...routed, decision }, pin !== undefined);
    return decision;
  }

  private journalRouting(node: TaskNode, spec: StepSpec, r: Routed, pinned: boolean): void {
    const d = r.decision;
    if (r.diversity) {
      this.intervention(node.id, {
        action: 'diversity waived',
        role: spec.role,
        excluded: r.excluded,
        chosen: refToString(d.chosen.ref),
        reason: 'allowSameProvider: no other provider available (principle 2 override)',
      });
    }
    this.o.journal.append({
      sessionId: this.o.sessionId,
      type: 'routing',
      nodeId: node.id,
      provider: d.chosen.ref.provider,
      model: d.chosen.ref.model,
      payload: {
        role: spec.role,
        reason: d.reason,
        elapsedMs: d.elapsedMs,
        taskType: node.type,
        score: d.chosen.score,
        fallbacks: d.fallbacks.map((f) => refToString(f.ref)),
        excludedProviders: r.excluded,
        ...(r.diversity ? { diversity: r.diversity } : {}),
        ...(pinned ? { pinned: true } : {}),
        ...proposedOf(node),
      },
    });
  }
}

/** The pack's name for the node's work (`mapsTo` routed as `taskType`), for calibration. */
function proposedOf(node: TaskNode): { proposedType?: string } {
  const p = (node as PlannedNode).proposedType;
  return typeof p === 'string' ? { proposedType: p } : {};
}

function failed(error: string, costUsd: number, cancelled: boolean): StepFailed {
  return { ok: false, error, costUsd, cancelled };
}
