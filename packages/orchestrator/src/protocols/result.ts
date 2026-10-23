import type { ProtocolName, ProtocolResult } from '@kernelpai/core';
import type { NodeRun, StepFailed } from '../types.js';

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** A protocol that produced its output. */
export function finish(
  run: NodeRun,
  protocol: ProtocolName,
  output: string,
  approved?: boolean,
): ProtocolResult {
  return {
    nodeId: run.node.id,
    protocol,
    output,
    contributions: run.contributions,
    costUsd: round6(run.costUsd),
    ...(approved !== undefined ? { approved } : {}),
    ok: true,
  };
}

/**
 * A protocol that stopped on a failed step. The output keeps the best text so far (the
 * given one, else the last contribution) so partial work is never lost.
 */
export function failure(
  run: NodeRun,
  protocol: ProtocolName,
  step: Pick<StepFailed, 'error'>,
  output?: string,
): ProtocolResult {
  return {
    nodeId: run.node.id,
    protocol,
    output: output ?? run.contributions.at(-1)?.text ?? '',
    contributions: run.contributions,
    costUsd: round6(run.costUsd),
    ok: false,
    error: step.error,
  };
}
