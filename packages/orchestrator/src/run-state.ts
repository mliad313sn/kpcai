import type { Contribution, NodeState, ProtocolResult, TaskGraph } from '@kernelpai/core';
import type { PlannedNode } from './types.js';

/** Live state of one graph run, shared by the scheduler and the run controller. */
export interface Run {
  /** A private copy of the approved graph; control actions replace its nodes. */
  graph: TaskGraph & { nodes: PlannedNode[] };
  states: Record<string, NodeState>;
  results: Map<string, ProtocolResult>;
  running: Map<string, Promise<void>>;
  /** Abort controller of each running node's current attempt (redirect cancels it). */
  attempts: Map<string, AbortController>;
  /** Running nodes whose attempt is being cancelled to rerun on another model. */
  redirecting: Set<string>;
  /** Cost and contributions of cancelled attempts, merged into the node's final result. */
  carried: Map<string, { costUsd: number; contributions: Contribution[] }>;
  /** Aborted by the caller's signal or by `cancel()`. */
  signal: AbortSignal;
  cancel: AbortController;
  paused: boolean;
  /** Resolves on the next control action; the scheduler waits on it while paused. */
  woken: Promise<void>;
  wake: () => void;
}

export function newRun(graph: TaskGraph, signal: AbortSignal | undefined): Run {
  const cancel = new AbortController();
  const r: Run = {
    graph: { ...graph, nodes: structuredClone(graph.nodes) as PlannedNode[] },
    states: {},
    results: new Map(),
    running: new Map(),
    attempts: new Map(),
    redirecting: new Set(),
    carried: new Map(),
    signal: signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal,
    cancel,
    paused: false,
    woken: Promise.resolve(),
    wake: () => undefined,
  };
  rearm(r);
  r.signal.addEventListener('abort', () => wake(r), { once: true });
  return r;
}

function rearm(r: Run): void {
  r.woken = new Promise((resolve) => {
    r.wake = resolve;
  });
}

/** Wakes the scheduler (it re-reads states, pause and node edits). */
export function wake(r: Run): void {
  const resolve = r.wake;
  rearm(r);
  resolve();
}

export function nodeOf(r: Run, id: string): PlannedNode | undefined {
  return r.graph.nodes.find((n) => n.id === id);
}

export function replaceNode(r: Run, node: PlannedNode): void {
  r.graph = { ...r.graph, nodes: r.graph.nodes.map((n) => (n.id === node.id ? node : n)) };
}

/** Providers that served each finished node (for re-estimates after a control action). */
export function servedProviders(r: Run): Map<string, string[]> {
  const known = new Map<string, string[]>();
  for (const [id, res] of r.results) {
    known.set(id, [...new Set(res.contributions.map((c) => c.ref.provider))]);
  }
  return known;
}

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** A node's result with the cost and contributions of its cancelled attempts first. */
export function withCarried(r: Run, res: ProtocolResult): ProtocolResult {
  const prior = r.carried.get(res.nodeId);
  if (!prior) return res;
  return {
    ...res,
    contributions: [...prior.contributions, ...res.contributions],
    costUsd: r6(prior.costUsd + res.costUsd),
  };
}

/** Keeps a cancelled attempt's cost and contributions (nothing is lost on redirect). */
export function carry(r: Run, res: ProtocolResult): void {
  const merged = withCarried(r, res);
  r.carried.set(res.nodeId, { costUsd: merged.costUsd, contributions: merged.contributions });
}
