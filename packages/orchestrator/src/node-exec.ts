import type { ProtocolName, ProtocolResult } from '@kernelpai/core';
import { isDisputed, settleDispute, type DisputeRecord } from './dispute.js';
import { PROTOCOLS } from './protocols/registry.js';
import type { StepRunner } from './step.js';
import type { NodeRun, PlannedNode } from './types.js';

/** A node's protocol run to its end: result, wall time, and how a dispute was settled. */
export interface NodeOutcome {
  result: ProtocolResult;
  durationMs: number;
  dispute?: DisputeRecord;
}

/**
 * Runs one node's protocol (a throw becomes a failed result with the work so far), then
 * settles a dispute with the human (R-405). Shared by the graph runner and replay.
 */
export async function execNode(
  steps: StepRunner,
  runId: string,
  run: NodeRun,
  protocol: ProtocolName,
): Promise<NodeOutcome> {
  const started = Date.now();
  let result: ProtocolResult;
  try {
    result = await PROTOCOLS[protocol](steps, run);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    result = {
      nodeId: run.node.id,
      protocol,
      output: '',
      contributions: run.contributions,
      costUsd: run.costUsd,
      ok: false,
      error,
    };
  }
  let dispute: DisputeRecord | undefined;
  if (isDisputed(result)) {
    const node = run.node as PlannedNode;
    const settled = await settleDispute({ steps, runId, node, signal: run.signal }, result);
    result = settled.result;
    dispute = settled.record;
  }
  return { result, durationMs: Date.now() - started, ...(dispute ? { dispute } : {}) };
}
