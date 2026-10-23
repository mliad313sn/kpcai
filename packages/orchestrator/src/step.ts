import {
  refToString,
  type Contribution,
  type GraphEvent,
  type GraphNode,
  type RoutingDecision,
  type ScoredCandidate,
  type TaskNode,
} from '@kernelpai/core';
import { FallbackExecutor } from '@kernelpai/executor';
import { GraphBudget } from './graph-budget.js';
import { stepMessages } from './prompts.js';
import { preferRef, routeDiverse, type Routed } from './routing.js';
import { executeWithTools } from './tool-loop.js';
import {
  OrchestrationError,
  type NodeRun,
  type OrchestratorOptions,
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

  constructor(readonly o: OrchestratorOptions) {
    this.executor = new FallbackExecutor(o.resolve, o.journal, o.executor);
    this.graph = new GraphBudget(
      o.maxGraphUsd,
      o.budget && ((c, l) => this.hook(c, l)),
      o.journal,
      o.sessionId,
    );
  }

  emit(event: GraphEvent): void {
    try {
      this.o.onEvent?.(event);
    } catch {
      // A broken listener never breaks the run.
    }
  }

  /**
   * Spend gate of every model call: the graph cap first (`maxGraphUsd`), then the budget
   * hook. A throw counts as a refusal (as in the executor).
   */
  async allow(c: ScoredCandidate, label: string, nodeId?: string): Promise<boolean> {
    if (!(await this.graph.check(c, label, nodeId))) return false;
    return this.hook(c, label);
  }

  private async hook(c: ScoredCandidate, label: string): Promise<boolean> {
    if (!this.o.budget) return true;
    try {
      return (await this.o.budget(c, label)) !== false;
    } catch {
      return false;
    }
  }

  intervention(nodeId: string, payload: Record<string, unknown>): void {
    this.o.journal.append({ sessionId: this.o.sessionId, type: 'intervention', nodeId, payload });
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
    let decision: RoutingDecision;
    try {
      decision = spec.decision ?? this.decide(stepNode, spec);
    } catch (err) {
      const f = failed(errorText(err), 0, false);
      return err instanceof OrchestrationError ? { ...f, diversity: true } : f;
    }
    const label = `${spec.role} on ${run.node.id}: ${refToString(decision.chosen.ref)}`;
    if (!(await this.allow(decision.chosen, label, run.node.id))) {
      this.intervention(run.node.id, { action: 'step blocked by budget', role: spec.role, label });
      return failed(`budget: ${label} not allowed`, 0, false);
    }
    const release = this.graph.reserve(decision.chosen.estimate.expectedCostUsd);
    const loop = await executeWithTools(this, run, spec, stepNode, decision).finally(release);
    run.costUsd += loop.costUsd;
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

  private decide(node: TaskNode, spec: StepSpec): RoutingDecision {
    const routed = routeDiverse(this.o, node, spec);
    const decision = spec.prefer ? preferRef(routed.decision, spec.prefer) : routed.decision;
    this.journalRouting(node, spec, { ...routed, decision });
    return decision;
  }

  private journalRouting(node: TaskNode, spec: StepSpec, r: Routed): void {
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
      },
    });
  }
}

function failed(error: string, costUsd: number, cancelled: boolean): StepFailed {
  return { ok: false, error, costUsd, cancelled };
}
