import type { ModelRef, ProtocolName, ProtocolResult } from '@kernelpai/core';
import { cap } from './prompts.js';
import type { StepRunner } from './step.js';
import type { NodeRun, PlannedNode } from './types.js';

/** Who disagrees (R-405). */
export type DisputeKind = 'critics' | 'judges' | 'vote';

/** One answer the human may choose. `text` is untrusted model output, shown quoted. */
export interface DisputeOption {
  id: string;
  label: string;
  text: string;
  /** Models that back this option. */
  backers: ModelRef[];
}

/** One reviewer's position, for the human to read before choosing. */
export interface DisputePosition {
  ref: ModelRef;
  role: 'critic' | 'judge' | 'voter';
  /** What it said: verdict summary and issues, the judge's pick, or the vote. */
  says: string;
  /** The option it backs (critics: `accept`, or none when it rejects). */
  option?: string;
}

export interface Dispute {
  kind: DisputeKind;
  reason: string;
  options: DisputeOption[];
  positions: DisputePosition[];
}

/** What the human is asked (the kernel maps it to its confirm channel). */
export interface DisputeQuestion extends Dispute {
  runId: string;
  nodeId: string;
  title: string;
}

/** Returns the chosen option id, or null to reject. A throw counts as no answer. */
export type DisputeHook = (question: DisputeQuestion) => Promise<string | null>;

/** How a dispute ended: an option chosen by the human, or none (the node fails closed). */
export interface DisputeRecord extends Dispute {
  choice: string | null;
  by: 'human' | 'none';
  /** Why no option was taken (`no human`, `rejected`, `invalid choice`, `cancelled`). */
  unresolved?: string;
}

/** A protocol result carrying a dispute, before the runner settles it. */
export type DisputedResult = ProtocolResult & { dispute: Dispute };

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const MAX_SAYS = 600;

/** A protocol outcome with no answer picked: the runner asks the human. */
export function disputed(run: NodeRun, protocol: ProtocolName, dispute: Dispute): DisputedResult {
  return {
    nodeId: run.node.id,
    protocol,
    output: '',
    contributions: run.contributions,
    costUsd: r6(run.costUsd),
    ok: false,
    error: `disputed: ${dispute.reason}`,
    dispute: {
      ...dispute,
      positions: dispute.positions.map((p) => ({ ...p, says: cap(p.says, MAX_SAYS) })),
    },
  };
}

export function isDisputed(r: ProtocolResult): r is DisputedResult {
  return typeof (r as Partial<DisputedResult>).dispute === 'object';
}

/** Context of a dispute's settlement. */
export interface DisputeContext {
  steps: StepRunner;
  runId: string;
  node: PlannedNode;
  signal?: AbortSignal | undefined;
}

/**
 * Settles a disputed result (R-405): reports it (`node_disputed`, journaled), asks the
 * human through `dispute`, and returns the result without its dispute field. A chosen
 * option makes the node succeed with that option's text (approved by a human). No hook,
 * a rejection, an unknown option, a throw or a cancel leaves it failed: no output, so no
 * patch and no artifact (fails closed).
 */
export async function settleDispute(
  c: DisputeContext,
  result: DisputedResult,
): Promise<{ result: ProtocolResult; record: DisputeRecord }> {
  const { dispute, ...plain } = result;
  const { steps, node } = c;
  const options = dispute.options.map((o) => ({ id: o.id, label: o.label }));
  steps.intervention(node.id, {
    action: 'node disputed',
    runId: c.runId,
    kind: dispute.kind,
    reason: dispute.reason,
    options: dispute.options.map((o) => ({ id: o.id, label: o.label, backers: o.backers })),
    positions: dispute.positions,
  });
  steps.emit({ type: 'node_state', nodeId: node.id, state: 'review' });
  control(steps, {
    type: 'node_disputed',
    nodeId: node.id,
    kind: dispute.kind,
    reason: dispute.reason,
    options,
  });
  const answer = await ask(c, dispute);
  const chosen = dispute.options.find((o) => o.id === answer.choice);
  const record: DisputeRecord = chosen
    ? { ...dispute, choice: chosen.id, by: 'human' }
    : { ...dispute, choice: null, by: 'none', unresolved: answer.why ?? 'invalid choice' };
  steps.intervention(node.id, {
    action: chosen ? 'dispute resolved' : 'dispute unresolved',
    runId: c.runId,
    choice: record.choice,
    by: record.by,
    ...(record.unresolved ? { reason: record.unresolved } : {}),
  });
  control(steps, {
    type: 'dispute_resolved',
    nodeId: node.id,
    choice: record.choice,
    by: record.by,
  });
  if (!chosen) {
    const why = `disputed: ${dispute.reason}; ${record.unresolved} (fails closed)`;
    return { result: { ...plain, output: '', ok: false, error: why }, record };
  }
  const ok: ProtocolResult = { ...plain, output: chosen.text, ok: true };
  delete ok.error;
  if (plain.protocol === 'author_critic') ok.approved = true;
  return { result: ok, record };
}

async function ask(
  c: DisputeContext,
  d: Dispute,
): Promise<{ choice: string | null; why?: string }> {
  const hook = c.steps.o.dispute;
  if (!hook) return { choice: null, why: 'no human to decide' };
  if (c.signal?.aborted) return { choice: null, why: 'cancelled' };
  const question: DisputeQuestion = {
    ...d,
    runId: c.runId,
    nodeId: c.node.id,
    title: c.node.title,
  };
  try {
    const choice = await abortable(hook(question), c.signal);
    if (choice === undefined) return { choice: null, why: 'cancelled' };
    if (choice === null) return { choice: null, why: 'rejected by the human' };
    return { choice };
  } catch {
    return { choice: null, why: 'no answer' };
  }
}

function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (!signal) return p;
  return new Promise<T | undefined>((resolve, reject) => {
    const stop = (): void => resolve(undefined);
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

function control(
  steps: StepRunner,
  e: Parameters<NonNullable<StepRunner['o']['onControl']>>[0],
): void {
  try {
    steps.o.onControl?.(e);
  } catch {
    // A broken listener never breaks the run.
  }
}
