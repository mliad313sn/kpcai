import type {
  GraphNode,
  GraphResult,
  NodeState,
  ProtocolName,
  ProtocolResult,
  TaskGraph,
} from '@kernelpai/core';
import { quote } from './prompts.js';
import { PROTOCOLS } from './protocols/registry.js';
import { StepRunner } from './step.js';
import { nodeTools } from './tool-loop.js';
import {
  DEFAULT_CONCURRENCY,
  OrchestrationError,
  type NodeRun,
  type OrchestratorOptions,
} from './types.js';
import { graphProblems } from './validate.js';

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
  if (node.criticality === 'critical' && node.protocol === 'solo') {
    return 'critical node always gets an independent critic (principle 2)';
  }
  return undefined;
}

interface Run {
  graph: TaskGraph;
  states: Record<string, NodeState>;
  results: Map<string, ProtocolResult>;
  running: Map<string, Promise<void>>;
  signal?: AbortSignal | undefined;
}

/**
 * Runs a task graph: ready nodes (all dependencies done) start in graph order, up to
 * `concurrency` at once; each node's protocol receives its dependencies' outputs as quoted
 * context. A failed node marks its dependants `skipped`; independent branches go on.
 * Cancellation (signal) stops running steps, keeps their partial output and marks nodes
 * not started `cancelled`. Results are keyed and ordered as the graph's nodes.
 */
export class GraphRunner {
  private readonly steps: StepRunner;

  constructor(private readonly o: OrchestratorOptions) {
    this.steps = new StepRunner(o);
  }

  async run(graph: TaskGraph, options: { signal?: AbortSignal } = {}): Promise<GraphResult> {
    const problems = graphProblems(graph.nodes);
    if (problems.length > 0) throw new OrchestrationError(`invalid graph: ${problems.join('; ')}`);
    const r: Run = {
      graph,
      states: {},
      results: new Map(),
      running: new Map(),
      signal: options.signal,
    };
    this.steps.graph.reset();
    for (const n of graph.nodes) this.setState(r, n.id, 'pending');
    const limit = Math.max(1, Math.floor(this.o.concurrency ?? DEFAULT_CONCURRENCY));
    for (;;) {
      this.settlePending(r);
      for (const n of this.ready(r)) {
        if (r.running.size >= limit) break;
        this.start(r, n);
      }
      if (r.running.size === 0) break;
      await Promise.race(r.running.values());
    }
    return this.result(r);
  }

  private ready(r: Run): GraphNode[] {
    return r.graph.nodes.filter(
      (n) => r.states[n.id] === 'pending' && n.dependsOn.every((d) => r.states[d] === 'done'),
    );
  }

  /** Pending nodes behind a failure become skipped; after a cancel, all become cancelled. */
  private settlePending(r: Run): void {
    for (let changed = true; changed;) {
      changed = false;
      for (const n of r.graph.nodes) {
        if (r.states[n.id] !== 'pending') continue;
        if (r.signal?.aborted) this.setState(r, n.id, 'cancelled');
        else if (n.dependsOn.some((d) => BLOCKING.has(r.states[d] as NodeState))) {
          this.setState(r, n.id, 'skipped');
          changed = true;
        }
      }
    }
  }

  private start(r: Run, node: GraphNode): void {
    this.setState(r, node.id, 'running');
    const p = this.runNode(r, node).finally(() => r.running.delete(node.id));
    r.running.set(node.id, p);
  }

  private async runNode(r: Run, node: GraphNode): Promise<void> {
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
    const run: NodeRun = {
      node,
      context: this.context(r, node),
      signal: r.signal,
      upstream: this.upstream(r, node),
      contributions: [],
      costUsd: 0,
    };
    let result: ProtocolResult;
    try {
      result = await PROTOCOLS[protocol](this.steps, run);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result = {
        nodeId: node.id,
        protocol,
        output: '',
        contributions: run.contributions,
        costUsd: run.costUsd,
        ok: false,
        error,
      };
    }
    r.results.set(node.id, result);
    const state: NodeState = result.ok ? 'done' : r.signal?.aborted ? 'cancelled' : 'failed';
    this.setState(r, node.id, state);
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

  private result(r: Run): GraphResult {
    const results: Record<string, ProtocolResult> = {};
    const states: Record<string, NodeState> = {};
    let cost = 0;
    for (const n of r.graph.nodes) {
      states[n.id] = r.states[n.id] as NodeState;
      const res = r.results.get(n.id);
      if (res) {
        results[n.id] = res;
        cost += res.costUsd;
      }
    }
    const costUsd = Math.round(cost * 1e6) / 1e6;
    const ok = Object.values(states).every((s) => s === 'done');
    this.steps.emit({ type: 'graph_done', costUsd, ok });
    return { graphId: r.graph.id, results, states, costUsd, ok };
  }
}
