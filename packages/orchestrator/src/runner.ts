import { randomUUID } from 'node:crypto';
import {
  refToString,
  type GraphNode,
  type GraphResult,
  type ModelRef,
  type NodeState,
  type ProtocolName,
  type ProtocolResult,
  type TaskGraph,
} from '@kernelpai/core';
import type { Pack } from '@kernelpai/packs';
import { RunController, type ControlOutcome, type RunControl, type RunStatus } from './control.js';
import { deliverableOf, extractArtifacts, shapeOf, type NodeDeliverable } from './deliverable.js';
import type { DisputeRecord } from './dispute.js';
import { execNode } from './node-exec.js';
import { quote } from './prompts.js';
import { reviewedNode } from './review-policy.js';
import { sameRef } from './routing.js';
import { journalNode, journalRunStart, type ForkOrigin, type RecordedNode } from './run-journal.js';
import { carry, newRun, withCarried, type Run } from './run-state.js';
import {
  ScopeError,
  checkRunScope,
  scopePayloads,
  stampScope,
  type ScopeCheck,
} from './scope-gate.js';
import { StepRunner } from './step.js';
import { nodeTools } from './tool-loop.js';
import {
  DEFAULT_CONCURRENCY,
  OrchestrationError,
  type NodeRun,
  type OrchestratorOptions,
  type PlannedNode,
} from './types.js';
import { graphProblems } from './validate.js';
import { verificationRoi, type VerificationRoi } from './verification.js';

const BLOCKING: ReadonlySet<NodeState> = new Set(['failed', 'skipped', 'cancelled']);

/** Critical nodes always get a critic (principle 2): solo is upgraded to author+critic. */
export function effectiveProtocol(node: GraphNode): ProtocolName {
  return upgradeReason(node) ? 'author_critic' : node.protocol;
}

/**
 * Why a node's planned protocol is replaced by author+critic (principle 2), if it is:
 * code and tests are always reviewed by another provider, whatever the plan (template or
 * model) says (review P2-F4); a critical solo node always gets a critic.
 */
export function upgradeReason(node: GraphNode): string | undefined {
  if (node.protocol === 'author_critic') return undefined;
  if (node.type === 'code_generation' || node.type === 'test') {
    return `${node.type} is always reviewed by another provider (principle 2)`;
  }
  const shape = shapeOf(deliverableOf(node as PlannedNode));
  if (shape === 'diff' || shape === 'files') {
    return `a ${(node as PlannedNode).deliverable} deliverable is always reviewed by another provider (principle 2)`;
  }
  if (node.criticality === 'critical' && node.protocol === 'solo') {
    return 'critical node always gets an independent critic (principle 2)';
  }
  return undefined;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** The user's edits to the proposed plan (`validatePlan(...).changes`), journaled. */
  edits?: string[];
  /**
   * The domain packs selected for this run. A pack with `safety.requiresScope` makes the
   * run refuse to start without a valid `scope` (WI-S4-02); nodes tagged with a pack that
   * is not listed are refused (fail closed).
   */
  packs?: readonly Pack[];
  /** The declared authorised scope (`AuthorisedScope` of `@kernelpai/packs`), validated here. */
  scope?: unknown;
  /** Clock for the scope expiry; default now. */
  now?: () => Date;
  /** The kernel's run id, journaled with the run's record (R-403); default a new UUID. */
  runId?: string;
  /**
   * A fork (`planFork`): these nodes keep their parent run's recorded result and are not
   * re-run ("reused, not re-run"); the parent is journaled with the run.
   */
  fork?: { parent: ForkOrigin; reuse: Readonly<Record<string, RecordedNode>> };
}

/** A graph result plus each finished node's deliverable and extracted artifacts. */
export interface RunResult extends GraphResult {
  runId: string;
  /** By node id, for nodes that finished ok, in graph order (for the kernel, S1/ADR-0021). */
  deliverables: Record<string, NodeDeliverable>;
  /** Fork: nodes whose result was reused from the parent run (their cost is not counted). */
  reused: string[];
  /** Disputed nodes (R-405) and how each was settled; unresolved ones failed closed. */
  disputes: Record<string, DisputeRecord>;
  /** Review spend against accepted findings (R-404), over the nodes that ran. */
  verification: VerificationRoi;
}

/**
 * Runs a task graph: ready nodes (all dependencies done) start in graph order, up to
 * `concurrency` at once; each node's protocol receives its dependencies' outputs as quoted
 * context. A failed node marks its dependants `skipped`; independent branches go on.
 * Cancellation (signal) stops running steps, keeps their partial output and marks nodes
 * not started `cancelled`. Results are keyed and ordered as the graph's nodes.
 *
 * The runner runs a private copy of the graph it is given (the approved plan, R-301);
 * nodes with a `model` run their first step on it. While `run` is active the runner is
 * also the run's `RunControl` (pause, resume, cancel, redirect, addInstruction).
 * One run at a time per runner.
 */
export class GraphRunner implements RunControl {
  private readonly steps: StepRunner;
  private readonly control: RunController;

  constructor(private readonly o: OrchestratorOptions) {
    this.steps = new StepRunner(o);
    this.control = new RunController(this.steps);
  }

  async run(graph: TaskGraph, options: RunOptions = {}): Promise<RunResult> {
    const reuse = options.fork?.reuse ?? {};
    const problems = [...graphProblems(graph.nodes), ...this.pinProblems(graph, reuse)];
    if (problems.length > 0) throw new OrchestrationError(`invalid graph: ${problems.join('; ')}`);
    if (this.control.run) throw new OrchestrationError('this runner is already running a graph');
    const scope = this.admit(graph, options);
    const r = newRun(this.policy(graph, reuse), options.signal, options.runId ?? randomUUID());
    stampScope(r.graph.nodes, scope.boundary);
    this.control.run = r;
    this.steps.graph.reset();
    this.steps.nodes.reset();
    if (options.edits?.length) {
      this.steps.intervention(undefined, { action: 'plan edited', changes: options.edits });
    }
    const fork = options.fork && { parent: options.fork.parent, reused: Object.keys(reuse) };
    journalRunStart(this.steps, r.runId, r.graph, fork);
    try {
      for (const n of r.graph.nodes) this.setState(r, n.id, 'pending');
      this.preload(r, reuse);
      await this.schedule(r);
    } finally {
      this.control.run = undefined;
    }
    return this.result(r);
  }

  /** R-404: the review policy on the nodes that will run (journaled per change). */
  private policy(graph: TaskGraph, reuse: Readonly<Record<string, RecordedNode>>): TaskGraph {
    const policy = this.o.reviewPolicy;
    if (!policy) return graph;
    const nodes = (graph.nodes as PlannedNode[]).map((n) => {
      if (reuse[n.id]) return n;
      const { node, change } = reviewedNode(n, policy);
      if (change)
        this.steps.intervention(n.id, { action: 'protocol set by review policy', ...change });
      return node;
    });
    return { ...graph, nodes };
  }

  /** Fork: reused nodes are done with their parent's result, journaled as reused, not re-run. */
  private preload(r: Run, reuse: Readonly<Record<string, RecordedNode>>): void {
    for (const n of r.graph.nodes) {
      const rec = reuse[n.id];
      if (!rec) continue;
      r.reused.add(n.id);
      r.results.set(n.id, rec.result);
      const { eventId, ...kept } = rec;
      journalNode(this.steps, r.runId, { ...kept, node: n, reused: true, reusedFrom: eventId });
      this.setState(r, n.id, 'done');
    }
  }

  /**
   * The scope gate (WI-S4-02): refuses (journaled, nothing scheduled, no provider called)
   * when a selected pack needs an authorised scope that is missing, expired, unbounded or
   * out of kind; journals the accepted scope (targets as `kind:value`, no notes).
   */
  private admit(graph: TaskGraph, options: RunOptions): ScopeCheck {
    const packs = options.packs ?? [];
    const now = options.now?.() ?? new Date();
    const check = checkRunScope(packs, graph.nodes as PlannedNode[], options.scope, now);
    if (!check.ok) {
      this.steps.intervention(undefined, {
        action: 'run refused',
        reason: 'authorised scope',
        packs: check.required,
        problems: check.problems,
      });
      throw new ScopeError(check.required, check.problems);
    }
    for (const payload of scopePayloads(packs, check)) {
      this.steps.intervention(undefined, { action: 'scope accepted', ...payload });
    }
    return check;
  }

  pause(): ControlOutcome {
    return this.control.pause();
  }

  resume(): ControlOutcome {
    return this.control.resume();
  }

  cancel(): ControlOutcome {
    return this.control.cancel();
  }

  redirect(nodeId: string, to: ModelRef): Promise<ControlOutcome> {
    return this.control.redirect(nodeId, to);
  }

  addInstruction(nodeId: string, text: string): ControlOutcome {
    return this.control.addInstruction(nodeId, text);
  }

  status(): RunStatus {
    return this.control.status();
  }

  /** Starts ready nodes unless paused; while paused and idle, waits for a control action. */
  private async schedule(r: Run): Promise<void> {
    const limit = Math.max(1, Math.floor(this.o.concurrency ?? DEFAULT_CONCURRENCY));
    for (;;) {
      this.settlePending(r);
      if (!r.paused) {
        for (const n of this.ready(r)) {
          if (r.running.size >= limit) break;
          this.start(r, n);
        }
      }
      if (r.running.size === 0) {
        const waiting = r.graph.nodes.some((n) => r.states[n.id] === 'pending');
        if (!r.paused || !waiting) return;
        await r.woken;
        continue;
      }
      await Promise.race([...r.running.values(), r.woken]);
    }
  }

  private pinProblems(graph: TaskGraph, reuse: Readonly<Record<string, unknown>>): string[] {
    return (graph.nodes as PlannedNode[]).flatMap((n) =>
      n.model && !reuse[n.id] && !this.o.candidates.some((c) => sameRef(c.ref, n.model as ModelRef))
        ? [`node "${n.id}": model ${refToString(n.model)} is not available`]
        : [],
    );
  }

  private ready(r: Run): PlannedNode[] {
    return r.graph.nodes.filter(
      (n) =>
        r.states[n.id] === 'pending' &&
        !r.running.has(n.id) &&
        n.dependsOn.every((d) => r.states[d] === 'done'),
    );
  }

  /** Pending nodes behind a failure become skipped; after a cancel, all become cancelled. */
  private settlePending(r: Run): void {
    for (let changed = true; changed;) {
      changed = false;
      for (const n of r.graph.nodes) {
        if (r.states[n.id] !== 'pending') continue;
        if (r.signal.aborted) this.setState(r, n.id, 'cancelled');
        else if (n.dependsOn.some((d) => BLOCKING.has(r.states[d] as NodeState))) {
          this.setState(r, n.id, 'skipped');
          changed = true;
        }
      }
    }
  }

  private start(r: Run, node: PlannedNode): void {
    this.setState(r, node.id, 'running');
    const p = this.runNode(r, node).finally(() => r.running.delete(node.id));
    r.running.set(node.id, p);
  }

  private async runNode(r: Run, node: PlannedNode): Promise<void> {
    const protocol = effectiveProtocol(node);
    const why = upgradeReason(node);
    if (why) {
      this.steps.intervention(node.id, {
        action: 'protocol upgraded',
        from: node.protocol,
        to: protocol,
        reason: why,
      });
    }
    const unknown = nodeTools(this.o.tools, node).unknown;
    if (unknown.length > 0) {
      this.steps.intervention(node.id, { action: 'tools unavailable', tools: unknown });
    }
    const attempt = new AbortController();
    r.attempts.set(node.id, attempt);
    const run: NodeRun = {
      node,
      context: this.context(r, node),
      signal: AbortSignal.any([r.signal, attempt.signal]),
      upstream: this.upstream(r, node),
      contributions: [],
      costUsd: 0,
      priorUsd: r.carried.get(node.id)?.costUsd ?? 0,
      pin: node.model,
    };
    const out = await execNode(this.steps, r.runId, run, protocol);
    if (out.dispute) r.disputes.set(node.id, out.dispute);
    this.settle(r, out.result);
    this.record(r, run, protocol, out.durationMs);
  }

  /** The node's record for replay and fork (R-403): what it received and returned. */
  private record(r: Run, run: NodeRun, protocol: ProtocolName, durationMs: number): void {
    const id = run.node.id;
    const result = r.results.get(id);
    if (!result || r.states[id] === 'pending') return;
    const dependencies = Object.fromEntries(
      run.node.dependsOn.map((d) => [d, r.results.get(d)?.output ?? '']),
    );
    const dispute = r.disputes.get(id);
    journalNode(this.steps, r.runId, {
      state: r.states[id] as NodeState,
      node: run.node as PlannedNode,
      protocol,
      context: run.context,
      upstream: run.upstream ?? [],
      dependencies,
      result,
      durationMs,
      ...(dispute ? { dispute } : {}),
    });
  }

  /** Records a node's outcome; an attempt cancelled by a redirect goes back to pending. */
  private settle(r: Run, result: ProtocolResult): void {
    const id = result.nodeId;
    r.attempts.delete(id);
    const redirected = r.redirecting.delete(id);
    if (redirected && !result.ok && !r.signal.aborted) {
      carry(r, result);
      this.setState(r, id, 'pending');
      return;
    }
    if (redirected && result.ok) {
      this.steps.intervention(id, { action: 'redirect too late', reason: 'node finished first' });
    }
    r.results.set(id, withCarried(r, result));
    const state: NodeState = result.ok ? 'done' : r.signal.aborted ? 'cancelled' : 'failed';
    this.setState(r, id, state);
  }

  /** Dependency outputs, quoted as untrusted data. */
  private context(r: Run, node: GraphNode): string {
    return node.dependsOn
      .map((id) => {
        const dep = r.graph.nodes.find((n) => n.id === id);
        const label = `${dep?.title ?? id} (${id})`.replace(/[<>]/g, '');
        return quote(label, r.results.get(id)?.output ?? '');
      })
      .join('\n\n');
  }

  /** Distinct providers behind the dependencies' contributions, in order of appearance. */
  private upstream(r: Run, node: GraphNode): string[] {
    const providers = node.dependsOn.flatMap(
      (id) => r.results.get(id)?.contributions.map((c) => c.ref.provider) ?? [],
    );
    return [...new Set(providers)];
  }

  private setState(r: Run, nodeId: string, state: NodeState): void {
    r.states[nodeId] = state;
    this.steps.emit({ type: 'node_state', nodeId, state });
  }

  private result(r: Run): RunResult {
    const results: Record<string, ProtocolResult> = {};
    const states: Record<string, NodeState> = {};
    const deliverables: Record<string, NodeDeliverable> = {};
    const ran: ProtocolResult[] = [];
    for (const n of r.graph.nodes) {
      states[n.id] = r.states[n.id] as NodeState;
      const res = r.results.get(n.id);
      if (res) {
        results[n.id] = res;
        if (!r.reused.has(n.id)) ran.push(res);
        if (res.ok) deliverables[n.id] = extractArtifacts(n.id, deliverableOf(n), res.output);
      }
    }
    const costUsd = Math.round(ran.reduce((a, x) => a + x.costUsd, 0) * 1e6) / 1e6;
    const ok = Object.values(states).every((s) => s === 'done');
    this.steps.emit({ type: 'graph_done', costUsd, ok });
    return {
      graphId: r.graph.id,
      runId: r.runId,
      results,
      states,
      costUsd,
      ok,
      deliverables,
      reused: [...r.reused],
      disputes: Object.fromEntries(r.disputes),
      verification: verificationRoi(ran),
    };
  }
}
