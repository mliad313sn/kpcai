/**
 * Evidence, grades, replay and fork (ADR-0028, ADR-0029, R-402, R-403). A replay and a
 * fork spend through the kernel's budget gate: the kernel may ask a budget question while
 * the call waits, so their timeouts are long. A fork is shown as a plan (likely cost and
 * cap) and starts only when the user presses Run, like any plan.
 */
import { t } from '../i18n/core';
import type { MethodName } from '../rpc/client';
import { ProductivityViewSchema, ReplayViewSchema } from '../rpc/learning-schemas';
import { Methods } from '@kernelpai/kernel/protocol';
import { TaskGraphSchema, parseEstimate, type Ref } from '../rpc/schemas';
import { call, fail } from './actions';
import { costOf } from './cost';
import { formatUsd } from './format';
import { refKey } from './reducer';
import { announce, patch, studio } from './store';
import type { EvidenceView, PlanView } from './types';

export type Protocol = 'solo' | 'author_critic' | 'debate' | 'vote';
export interface NodeEditInput {
  model?: Ref;
  protocol?: Protocol;
  instruction?: string;
}

const SPEND_TIMEOUT_MS = 300_000;
const PLAN_TIMEOUT_MS = 120_000;

export const nodeKey = (runId: string, nodeId: string): string => `${runId}:${nodeId}`;

function setEvidence(update: (e: EvidenceView) => EvidenceView): void {
  patch({ evidence: update(studio.getState().evidence) });
}

/** R-406 is added by another seat: the method is asked for only when the protocol has it. */
const PRODUCTIVITY = 'stats.productivity' as MethodName;

async function loadProductivity(): Promise<void> {
  if (!Object.hasOwn(Methods, PRODUCTIVITY)) return;
  // Optional: accuracy and competence still show when this one fails.
  const raw = await call(PRODUCTIVITY, {} as never).catch(() => undefined);
  const parsed = ProductivityViewSchema.safeParse(raw);
  if (parsed.success) setEvidence((e) => ({ ...e, productivity: parsed.data }));
}

/** The accuracy table (R-402), productivity (R-406) and measured competence (ADR-0028). */
export async function loadEvidence(): Promise<void> {
  setEvidence((e) => ({ ...e, loading: true }));
  try {
    const [accuracy, { entries }] = await Promise.all([
      call('stats.accuracy', {}),
      call('competence', {}),
      loadProductivity(),
    ]);
    setEvidence((e) => ({ ...e, accuracy, competence: entries }));
  } catch (e) {
    fail('fail.evidence', e);
  } finally {
    setEvidence((e) => ({ ...e, loading: false }));
  }
}

let competenceAsked = false;

/** Measured competence for the routing panel, fetched once per connection (quietly). */
export function ensureCompetence(): void {
  const s = studio.getState();
  if (competenceAsked || s.evidence.competence || s.conn !== 'open') return;
  competenceAsked = true;
  call('competence', {})
    .then(({ entries }) => setEvidence((e) => ({ ...e, competence: entries })))
    .catch(() => {
      competenceAsked = false;
    });
}

export function resetCompetence(): void {
  competenceAsked = false;
}

/** A human's grade of a finished node (good/bad and a note), journaled with its author. */
export async function gradeNode(
  runId: string,
  nodeId: string,
  grade: 'good' | 'bad',
  note: string,
): Promise<boolean> {
  const text = note.trim().slice(0, 500);
  try {
    const r = await call('grade', { runId, nodeId, grade, ...(text ? { note: text } : {}) });
    const view = { grade, graded: r.graded, ...(text ? { note: text } : {}) };
    patch({ grades: { ...studio.getState().grades, [nodeKey(runId, nodeId)]: view } });
    announce(
      t(grade === 'good' ? 'grade.announce.good' : 'grade.announce.bad', { model: r.graded }),
    );
    // Competence changed: the routing panel fetches it again when it next needs it.
    setEvidence((e) => {
      const next = { ...e };
      delete next.competence;
      return next;
    });
    competenceAsked = false;
    return true;
  } catch (e) {
    fail('fail.grade', e);
    return false;
  }
}

/** Reruns one finished node with another model or protocol, beside the original. */
export async function replayNode(runId: string, nodeId: string, edit: NodeEditInput) {
  const key = nodeKey(runId, nodeId);
  const replays = () => studio.getState().replays;
  patch({ replays: { ...replays(), [key]: { pending: true } } });
  announce(t('replay.announce.started', { id: nodeId }));
  try {
    const raw = await call(
      'run.replay',
      {
        runId,
        nodeId,
        ...(edit.model ? { model: edit.model } : {}),
        ...(edit.protocol ? { protocol: edit.protocol } : {}),
      },
      SPEND_TIMEOUT_MS,
    );
    const parsed = ReplayViewSchema.safeParse(raw);
    if (!parsed.success) throw new Error(t('error.badReplay'));
    patch({ replays: { ...replays(), [key]: { pending: false, result: parsed.data } } });
    const r = parsed.data;
    announce(
      t('replay.announce.done', {
        id: nodeId,
        model: r.replay.models.map(refKey).join(', ') || '—',
        cost: formatUsd(r.replay.costUsd),
      }),
    );
  } catch (e) {
    const rest = { ...replays() };
    delete rest[key];
    patch({ replays: rest });
    fail('fail.replay', e);
  }
}

/** Plans a fork from a node; the plan waits in the thread until the user runs it. */
export async function planFork(runId: string, nodeId: string, edit: NodeEditInput) {
  patch({ planning: true });
  try {
    const raw = await call('run.forkPlan', { runId, nodeId, edit }, PLAN_TIMEOUT_MS);
    const graph = TaskGraphSchema.safeParse(raw.graph);
    const estimate = parseEstimate(raw.estimate, raw);
    if (!graph.success || !estimate) throw new Error(t('error.badPlan'));
    const fork = { parent: raw.parent, rerun: raw.rerun, reused: raw.reused, edits: raw.edits };
    const plan: PlanView = {
      planId: raw.planId,
      request: graph.data.request,
      graph: graph.data,
      original: graph.data,
      estimate,
      checking: false,
      fork,
    };
    patch({ plan, selectedNodeId: undefined });
    const cost = costOf(estimate);
    announce(
      t('fork.announce.ready', {
        count: fork.rerun.length,
        reused: fork.reused.length,
        expected: formatUsd(cost.expected),
        cap: formatUsd(cost.cap),
      }),
    );
  } catch (e) {
    fail('fail.fork', e);
  } finally {
    patch({ planning: false });
  }
}
