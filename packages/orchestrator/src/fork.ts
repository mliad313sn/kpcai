import { refToString, type ModelRef, type ProtocolName, type TaskGraph } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import { sumBands } from './band.js';
import { MAX_INSTRUCTION_CHARS, withInstruction } from './control.js';
import { estimateGraph, type EstimateDeps, type GraphEstimate } from './estimate.js';
import { ReplayError } from './replay.js';
import { sameRef } from './routing.js';
import { readRun, type ForkOrigin, type RecordedNode, type RecordedRun } from './run-journal.js';
import type { GraphRunner, RunOptions, RunResult } from './runner.js';
import type { PlannedNode } from './types.js';

/** The chosen node's changes in a fork (all optional). */
export interface ForkEdit {
  model?: ModelRef;
  protocol?: ProtocolName;
  /** Added to the node's request, as a mid-run instruction would be. */
  instruction?: string;
}

/** A fork ready to run: what is reused, what runs again, and what that costs. */
export interface ForkPlan {
  parent: ForkOrigin;
  /** The graph as recorded (rules and memory as they were), with the edit applied. */
  graph: TaskGraph & { nodes: PlannedNode[] };
  /** Finished nodes taken as recorded ("reused, not re-run"). */
  reuse: Record<string, RecordedNode>;
  /** The chosen node, its descendants and any node without a finished result, in graph order. */
  rerun: string[];
  /** Covers only the nodes in `rerun` (reused nodes cost nothing). */
  estimate: GraphEstimate;
  /** The edit in words, journaled as plan edits. */
  edits: string[];
}

const PROTOCOL_NAMES: ReadonlySet<string> = new Set(['solo', 'author_critic', 'debate', 'vote']);

/**
 * Plans a new run from node `nodeId` of a past run (spec §3.5): finished nodes outside the
 * chosen node's descendants are reused as recorded; the chosen node (edited, optionally)
 * and its descendants are re-routed, re-estimated and re-run, as is any node that never
 * finished. Throws `ReplayError` for an unknown run or node, or an invalid edit.
 */
export function planFork(
  journal: Journal,
  runId: string,
  nodeId: string,
  edit: ForkEdit,
  deps: EstimateDeps,
): ForkPlan {
  const run = readRun(journal, runId);
  if (!run) throw new ReplayError(`run ${runId} is not in the journal`);
  if (!run.graph.nodes.some((n) => n.id === nodeId)) {
    throw new ReplayError(`run ${runId} has no node "${nodeId}"`);
  }
  const rerun = rerunSet(run, nodeId);
  const reuse: Record<string, RecordedNode> = {};
  const edits: string[] = [];
  const nodes = run.graph.nodes.map((planned) => {
    const rec = run.nodes[planned.id];
    if (!rerun.has(planned.id) && rec) reuse[planned.id] = rec;
    const n: PlannedNode = structuredClone(rec?.node ?? (planned as PlannedNode));
    delete n.authorisedScope;
    return planned.id === nodeId ? applyEdit(n, edit, deps, edits) : n;
  });
  const graph = { ...run.graph, nodes };
  return {
    parent: { runId, nodeId },
    graph,
    reuse,
    rerun: nodes.filter((n) => rerun.has(n.id)).map((n) => n.id),
    estimate: forkEstimate(graph, rerun, reuse, deps),
    edits,
  };
}

/** Runs a planned fork on `runner` under a new run id (journaled with its parent). */
export function runFork(
  runner: GraphRunner,
  plan: ForkPlan,
  options: Omit<RunOptions, 'fork'> = {},
): Promise<RunResult> {
  return runner.run(plan.graph, {
    ...options,
    ...(plan.edits.length > 0 ? { edits: [...(options.edits ?? []), ...plan.edits] } : {}),
    fork: { parent: plan.parent, reuse: plan.reuse },
  });
}

/** The chosen node, its transitive dependants, and every node without a finished result. */
function rerunSet(run: RecordedRun, nodeId: string): Set<string> {
  const out = new Set<string>([nodeId]);
  for (const n of run.graph.nodes) {
    const rec = run.nodes[n.id];
    if (!rec || rec.state !== 'done' || !rec.result.ok) out.add(n.id);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const n of run.graph.nodes) {
      if (!out.has(n.id) && n.dependsOn.some((d) => out.has(d))) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

function applyEdit(
  node: PlannedNode,
  edit: ForkEdit,
  deps: EstimateDeps,
  edits: string[],
): PlannedNode {
  let n = node;
  if (edit.model) {
    const m = edit.model;
    if (!deps.candidates.some((c) => sameRef(c.ref, m))) {
      throw new ReplayError(`model ${refToString(m)} is not available`);
    }
    edits.push(`${n.id}: model ${n.model ? refToString(n.model) : 'routed'} → ${refToString(m)}`);
    n = { ...n, model: { provider: m.provider, model: m.model } };
  }
  if (edit.protocol !== undefined) {
    if (!PROTOCOL_NAMES.has(edit.protocol)) {
      throw new ReplayError(`unknown protocol "${String(edit.protocol)}"`);
    }
    edits.push(`${n.id}: protocol ${n.protocol} → ${edit.protocol}`);
    n = { ...n, protocol: edit.protocol };
  }
  const text = typeof edit.instruction === 'string' ? edit.instruction.trim() : '';
  if (text.length > MAX_INSTRUCTION_CHARS) {
    throw new ReplayError(`instruction longer than ${MAX_INSTRUCTION_CHARS} characters`);
  }
  if (text) {
    edits.push(`${n.id}: instruction added`);
    n = withInstruction(n, text);
  }
  return n;
}

/** The graph estimate restricted to the nodes that run; reused nodes count their real providers. */
function forkEstimate(
  graph: TaskGraph,
  rerun: ReadonlySet<string>,
  reuse: Readonly<Record<string, RecordedNode>>,
  deps: EstimateDeps,
): GraphEstimate {
  const known = new Map<string, readonly string[]>(deps.known ?? []);
  for (const [id, rec] of Object.entries(reuse)) {
    known.set(id, [...new Set(rec.result.contributions.map((c) => c.ref.provider))]);
  }
  const full = estimateGraph(graph, { ...deps, known });
  const nodes = full.nodes.filter((n) => rerun.has(n.nodeId));
  const sum = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) * 1e6) / 1e6;
  const problems = nodes.flatMap((n) => (n.error ? [`${n.nodeId}: ${n.error}`] : []));
  return {
    nodes,
    minUsd: sum(nodes.map((n) => n.minUsd)),
    totalUsd: sum(nodes.map((n) => n.expectedUsd)),
    complete: problems.length === 0,
    problems,
    band: sumBands(nodes.map((n) => n.band)),
  };
}
