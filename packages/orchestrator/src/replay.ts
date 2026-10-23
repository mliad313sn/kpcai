import { randomUUID } from 'node:crypto';
import {
  refToString,
  type ModelRef,
  type ProtocolName,
  type ProtocolResult,
} from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import type { DisputeRecord } from './dispute.js';
import { execNode } from './node-exec.js';
import { sameRef } from './routing.js';
import {
  REPLAY_RECORDED,
  REPLAY_STARTED,
  readRun,
  type RecordedNode,
  type RecordedRun,
} from './run-journal.js';
import { effectiveProtocol } from './runner.js';
import { StepRunner } from './step.js';
import type { NodeRun, OrchestratorOptions, PlannedNode } from './types.js';

/** What changes in a replay; nothing given replays the node as planned, routed afresh. */
export interface ReplayEdit {
  /** The model for the node's first step (pinned, principle 4); may be the same as before. */
  model?: ModelRef;
  protocol?: ProtocolName;
}

/** Everything a replay needs: the orchestrator options of a run, plus a cancel signal. */
export type ReplayDeps = OrchestratorOptions & { signal?: AbortSignal };

/** One attempt of a node, as the side-by-side view shows it. */
export interface AttemptView {
  protocol: ProtocolName;
  ok: boolean;
  output: string;
  error?: string;
  costUsd: number;
  durationMs: number;
  /** Models that contributed, in order of first appearance. */
  models: ModelRef[];
  /** Every critic verdict, in order. */
  verdicts: Array<{ ref: ModelRef; approve: boolean; issues: number; summary: string }>;
  approved?: boolean;
  dispute?: DisputeRecord;
}

export interface ReplayComparison {
  sameOutput: boolean;
  /** Replay minus original. */
  costDeltaUsd: number;
  durationDeltaMs: number;
  /** Approval of each side (author+critic), null when not applicable. */
  approved: { original: boolean | null; replay: boolean | null };
}

export interface ReplayResult {
  replayId: string;
  runId: string;
  nodeId: string;
  /** Journal events the replay is linked to: the run's start and the node's record. */
  links: { runStarted: string; nodeRecord: string };
  /** Kept as recorded, never replaced. */
  original: AttemptView;
  replay: AttemptView;
  comparison: ReplayComparison;
}

/** A replay that cannot start (unknown run or node, never ran, bad edit). */
export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayError';
  }
}

const PROTOCOL_NAMES: ReadonlySet<string> = new Set(['solo', 'author_critic', 'debate', 'vote']);
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Reruns one finished node of a past run (spec §3.5, R-403) from its record: the same
 * prompt, the dependency outputs and the rules and memory exactly as they were recorded.
 * The new attempt goes through routing constraints, diversity (principle 2), the budget
 * hook and `maxGraphUsd` like any step; it is journaled as a replay linked to the original
 * events and kept beside the original, which is never changed.
 */
export async function replayNode(
  journal: Journal,
  runId: string,
  nodeId: string,
  edit: ReplayEdit,
  deps: ReplayDeps,
): Promise<ReplayResult> {
  const { run, rec } = recorded(journal, runId, nodeId);
  const node = editedNode(rec.node, edit, deps);
  const protocol = effectiveProtocol(node);
  const replayId = randomUUID();
  const steps = new StepRunner(deps);
  const links = { runStarted: run.eventId, nodeRecord: rec.eventId };
  steps.intervention(nodeId, {
    action: REPLAY_STARTED,
    runId,
    replayId,
    links,
    ...(edit.model ? { model: refToString(edit.model) } : {}),
    protocol,
  });
  const nodeRun: NodeRun = {
    node,
    context: rec.context,
    signal: deps.signal,
    upstream: rec.upstream,
    contributions: [],
    costUsd: 0,
    pin: node.model,
    tags: { replayId, replayOf: runId },
  };
  const out = await execNode(steps, runId, nodeRun, protocol);
  const replay = view(protocol, out.result, out.durationMs, out.dispute);
  const original = view(rec.protocol, rec.result, rec.durationMs, rec.dispute);
  const comparison = compare(original, replay);
  steps.intervention(nodeId, {
    action: REPLAY_RECORDED,
    runId,
    replayId,
    links,
    protocol,
    result: out.result,
    durationMs: out.durationMs,
    comparison,
    ...(out.dispute ? { dispute: out.dispute } : {}),
  });
  return { replayId, runId, nodeId, links, original, replay, comparison };
}

function recorded(
  journal: Journal,
  runId: string,
  nodeId: string,
): { run: RecordedRun; rec: RecordedNode } {
  const run = readRun(journal, runId);
  if (!run) throw new ReplayError(`run ${runId} is not in the journal`);
  const rec = run.nodes[nodeId];
  if (!rec) {
    const known = run.graph.nodes.some((n) => n.id === nodeId);
    throw new ReplayError(
      known
        ? `node "${nodeId}" of run ${runId} never finished: nothing recorded to replay`
        : `run ${runId} has no node "${nodeId}"`,
    );
  }
  return { run, rec };
}

/** The recorded node with the replay's model and protocol; an old pin is not kept. */
function editedNode(recorded: PlannedNode, edit: ReplayEdit, deps: ReplayDeps): PlannedNode {
  const node: PlannedNode = structuredClone(recorded);
  delete node.model;
  if (edit.protocol !== undefined) {
    if (!PROTOCOL_NAMES.has(edit.protocol)) {
      throw new ReplayError(`unknown protocol "${String(edit.protocol)}"`);
    }
    node.protocol = edit.protocol;
  }
  if (edit.model) {
    const m = edit.model;
    if (!deps.candidates.some((c) => sameRef(c.ref, m))) {
      throw new ReplayError(`model ${refToString(m)} is not available`);
    }
    node.model = { provider: m.provider, model: m.model };
  }
  return node;
}

/** The side-by-side view of one attempt. */
export function view(
  protocol: ProtocolName,
  r: ProtocolResult,
  durationMs: number,
  dispute?: DisputeRecord,
): AttemptView {
  const models: ModelRef[] = [];
  for (const c of r.contributions) {
    if (!models.some((m) => sameRef(m, c.ref))) models.push(c.ref);
  }
  const verdicts = r.contributions.flatMap((c) =>
    c.verdict
      ? [
          {
            ref: c.ref,
            approve: c.verdict.approve,
            issues: c.verdict.issues.length,
            summary: c.verdict.summary,
          },
        ]
      : [],
  );
  return {
    protocol,
    ok: r.ok,
    output: r.output,
    ...(r.error !== undefined ? { error: r.error } : {}),
    costUsd: r.costUsd,
    durationMs,
    models,
    verdicts,
    ...(r.approved !== undefined ? { approved: r.approved } : {}),
    ...(dispute ? { dispute } : {}),
  };
}

function compare(a: AttemptView, b: AttemptView): ReplayComparison {
  return {
    sameOutput: a.output === b.output,
    costDeltaUsd: r6(b.costUsd - a.costUsd),
    durationDeltaMs: b.durationMs - a.durationMs,
    approved: { original: a.approved ?? null, replay: b.approved ?? null },
  };
}
