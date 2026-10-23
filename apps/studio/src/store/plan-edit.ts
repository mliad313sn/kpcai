/**
 * The editable plan (R-301): local edits apply at once (< 100 ms, no round trip), then the
 * edited graph is checked and re-estimated by `plan.validate`. Only the latest check is
 * kept; Run stays disabled while a check is pending or reports a problem.
 */
import { GraphEstimateSchema, type GraphNode, type Ref } from '../rpc/schemas';
import { t } from '../i18n/core';
import { call, fail, isEdited } from './actions';
import { announce, patch, studio } from './store';
import type { PlanView } from './types';

export const PROTOCOLS = ['solo', 'author_critic', 'debate', 'vote'] as const;
export const CRITICALITIES = ['low', 'normal', 'critical'] as const;
export type Protocol = (typeof PROTOCOLS)[number];
export type Criticality = (typeof CRITICALITIES)[number];

/** Fields the plan editor changes. `model: null` goes back to the router's choice. */
export interface NodeEdit {
  model?: Ref | null;
  protocol?: Protocol;
  criticality?: Criticality;
  /** Budget cap for the node in USD; `null` removes it. */
  budgetUsd?: number | null;
}

const VALIDATE_DELAY_MS = 120;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function applyEdit(node: GraphNode, edit: NodeEdit): GraphNode {
  const next: GraphNode = { ...node };
  if (edit.model === null) delete next.model;
  else if (edit.model) next.model = { provider: edit.model.provider, model: edit.model.model };
  if (edit.protocol) next.protocol = edit.protocol;
  if (edit.criticality) next.criticality = edit.criticality;
  if (edit.budgetUsd === null) delete next.budgetUsd;
  else if (edit.budgetUsd !== undefined) next.budgetUsd = edit.budgetUsd;
  return next;
}

function setGraph(plan: PlanView, nodes: GraphNode[]): void {
  const graph = { ...plan.graph, nodes };
  const next: PlanView = { ...plan, graph };
  if (!isEdited(next)) {
    // Back to the proposal: its estimate is the right one and nothing needs checking.
    seq++;
    clearTimeout(timer);
    patch({ plan: { ...next, check: undefined, checking: false } });
    return;
  }
  patch({ plan: { ...next, checking: true } });
  scheduleValidate();
}

export function editNode(nodeId: string, edit: NodeEdit): void {
  const plan = studio.getState().plan;
  const node = plan?.graph.nodes.find((n) => n.id === nodeId);
  if (!plan || !node) return;
  const next = applyEdit(node, edit);
  // Re-applying the same value (a blur after Enter) changes nothing and checks nothing.
  if (JSON.stringify(next) === JSON.stringify(node)) return;
  setGraph(
    plan,
    plan.graph.nodes.map((n) => (n.id === nodeId ? next : n)),
  );
}

/** Removes a node; nodes that waited for it wait for its own dependencies instead. */
export function removeNode(nodeId: string): void {
  const plan = studio.getState().plan;
  const gone = plan?.graph.nodes.find((n) => n.id === nodeId);
  if (!plan || !gone || plan.graph.nodes.length < 2) return;
  const nodes = plan.graph.nodes
    .filter((n) => n.id !== nodeId)
    .map((n) =>
      n.dependsOn.includes(nodeId)
        ? {
            ...n,
            dependsOn: [
              ...new Set([...n.dependsOn.filter((d) => d !== nodeId), ...gone.dependsOn]),
            ],
          }
        : n,
    );
  setGraph(plan, nodes);
  if (studio.getState().selectedNodeId === nodeId) patch({ selectedNodeId: undefined });
  announce(t('plan.announce.removed', { id: nodeId }));
}

export function resetPlan(): void {
  const plan = studio.getState().plan;
  if (!plan) return;
  setGraph(plan, plan.original.nodes);
  announce(t('plan.announce.reset'));
}

function scheduleValidate(): void {
  clearTimeout(timer);
  const mine = ++seq;
  timer = setTimeout(() => void validate(mine), VALIDATE_DELAY_MS);
}

/** Checks the plan as edited now; a reply to an older edit is dropped. */
export async function validate(mine = ++seq): Promise<void> {
  const plan = studio.getState().plan;
  if (!plan) return;
  try {
    const r = await call('plan.validate', {
      planId: plan.planId,
      graph: { nodes: plan.graph.nodes },
    });
    const current = studio.getState().plan;
    if (mine !== seq || current?.planId !== plan.planId) return;
    const est = r.estimate ? GraphEstimateSchema.safeParse(r.estimate) : undefined;
    const check = { ok: r.ok, problems: r.problems, warnings: r.warnings, changes: r.changes };
    patch({
      plan: {
        ...current,
        check,
        checking: false,
        ...(est?.success ? { estimate: est.data } : {}),
      },
    });
    announce(
      r.ok
        ? t('plan.announce.checked')
        : t('plan.announce.problem', { problem: r.problems[0] ?? '' }),
    );
  } catch (e) {
    if (mine !== seq) return;
    const current = studio.getState().plan;
    if (current) patch({ plan: { ...current, checking: false } });
    fail('fail.validate', e);
  }
}
