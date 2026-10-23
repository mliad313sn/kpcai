/** Derived views over the store, shared by the thread, the agents board and the tabs. */
import { useShallow } from 'zustand/react/shallow';
import { useStudio } from '../store/store';
import type { GraphEstimate, NodeEstimate, Ref, TaskGraph } from '../rpc/schemas';
import { isActive } from '../store/reducer';
import type { NodeRun, RunView, StudioState } from '../store/types';

export interface GraphView {
  mode: 'plan' | 'run';
  graph: TaskGraph;
  estimate?: GraphEstimate;
  run?: RunView;
}

/** A pending plan wins (it is what the user is about to decide on), else the active run. */
export function graphView(s: StudioState): GraphView | undefined {
  if (s.plan) return { mode: 'plan', graph: s.plan.graph, estimate: s.plan.estimate };
  const run = s.activeRunId ? s.runs[s.activeRunId] : undefined;
  if (run?.graph) return { mode: 'run', graph: run.graph, estimate: run.estimate, run };
  return undefined;
}

/** `graphView` builds a new object: compare it shallowly so React does not loop. */
export function useGraphView(): GraphView | undefined {
  return useStudio(useShallow(graphView));
}

export function activeRun(s: StudioState): RunView | undefined {
  return s.activeRunId ? s.runs[s.activeRunId] : undefined;
}

export function nodeEstimate(v: GraphView | undefined, id: string): NodeEstimate | undefined {
  return v?.estimate?.nodes.find((n) => n.nodeId === id);
}

export interface AgentRow {
  nodeId: string;
  title: string;
  ref: Ref;
  role: string;
  since: number;
  costUsd: number;
  score?: number;
  state: NodeRun['state'];
}

/** Spec §4.4: one row per model currently working. */
export function agentRows(run: RunView | undefined): AgentRow[] {
  if (!run) return [];
  const rows: AgentRow[] = [];
  for (const [nodeId, n] of Object.entries(run.nodes)) {
    if (!isActive(n.state) || !n.ref) continue;
    const est = run.estimate?.nodes.find((e) => e.nodeId === nodeId);
    const score = n.score ?? est?.score;
    rows.push({
      nodeId,
      title: run.graph?.nodes.find((g) => g.id === nodeId)?.title ?? nodeId,
      ref: n.ref,
      role: n.role ?? 'step',
      since: n.stepStartedAt ?? n.startedAt ?? run.startedAt,
      costUsd: n.costUsd,
      state: n.state,
      ...(score !== undefined ? { score } : {}),
    });
  }
  return rows;
}

export const RUN_LIVE: ReadonlySet<string> = new Set(['starting', 'running', 'paused']);
