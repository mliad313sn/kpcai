/**
 * Disputed nodes (R-405, ADR-0029). The kernel reports a dispute on the control feed
 * (`node_disputed`, then `dispute_resolved`) and in the run result (`disputes`). The node
 * shows "disputed" while the human is asked; a rejection, silence or a cancel leaves it
 * failed with no deliverable (fail closed). Option text is model output: shown as text.
 */
import type { DisputeRecord } from '../rpc/learning-schemas';
import type { ControlEvent } from '../rpc/schemas';
import type { DisputeView, RunView } from './types';

type Option = { id: string; label: string };

function options(e: Record<string, unknown>): Option[] {
  const raw = Array.isArray(e['options']) ? (e['options'] as unknown[]) : [];
  return raw.flatMap((o) => {
    const r = o as { id?: unknown; label?: unknown } | null;
    return r && typeof r.id === 'string' && typeof r.label === 'string'
      ? [{ id: r.id, label: r.label }]
      : [];
  });
}

/** Folds a `node_disputed` or `dispute_resolved` control event into the run. */
export function applyDisputeControl(run: RunView, e: ControlEvent): RunView {
  if ((e.type !== 'node_disputed' && e.type !== 'dispute_resolved') || !e.nodeId) return run;
  const x = e as ControlEvent & Record<string, unknown>;
  const all = run.disputes ?? {};
  const before = all[e.nodeId];
  let next: DisputeView;
  if (e.type === 'node_disputed') {
    next = { status: 'open', options: options(x), ...(e.reason ? { reason: e.reason } : {}) };
  } else {
    const id = typeof x['choice'] === 'string' ? x['choice'] : undefined;
    const label = id ? (before?.options?.find((o) => o.id === id)?.label ?? id) : undefined;
    next = { ...before, status: id ? 'chosen' : 'rejected', ...(label ? { choice: label } : {}) };
  }
  return { ...run, disputes: { ...all, [e.nodeId]: next } };
}

/** The run result's dispute records: how each disputed node was settled. */
export function applyDisputeRecords(run: RunView, records: Record<string, DisputeRecord>): RunView {
  const ids = Object.keys(records);
  if (ids.length === 0) return run;
  const disputes = { ...(run.disputes ?? {}) };
  for (const id of ids) {
    const r = records[id]!;
    const label = r.choice ? (r.options.find((o) => o.id === r.choice)?.label ?? r.choice) : '';
    disputes[id] = {
      status: r.choice ? 'chosen' : 'rejected',
      reason: r.reason,
      ...(label ? { choice: label } : {}),
      record: r,
    };
  }
  return { ...run, disputes };
}

/** True while the node waits for the human to settle its dispute. */
export function isDisputed(run: RunView | undefined, nodeId: string): boolean {
  return run?.disputes?.[nodeId]?.status === 'open';
}
