/**
 * Replay of one finished node (R-403) in two steps (P4-F5): `run.replayPlan` shows what it
 * would cost (likely and cap) and the routing it is held to before anything is spent; Run
 * then starts that plan once with `run.replay {planId}`, cancellable with
 * `run.cancel {runId: planId}`. Replay and fork are held to the original run's routing as
 * a floor (P4-F2); the console's own profile, local-only path and exclusions are sent as
 * options, which can only make it stricter.
 */
import type { RunOptions } from '@kernelpai/kernel/protocol';
import { t, type Key } from '../i18n/core';
import { ReplayViewSchema } from '../rpc/learning-schemas';
import { parseEstimate, type GraphEstimate } from '../rpc/schemas';
import { call, fail } from './actions';
import { costOf } from './cost';
import { formatUsd } from './format';
import { refKey } from './reducer';
import { announce, patch, studio, voidRunConfirms } from './store';
import type { NodeEditInput } from './learning';

const PLAN_TIMEOUT_MS = 120_000;
/** The kernel may ask a budget question while a replay waits: its timeout is long. */
const SPEND_TIMEOUT_MS = 300_000;

export const nodeKey = (runId: string, nodeId: string): string => `${runId}:${nodeId}`;

/** What `run.replayPlan` said: the cost before anything is spent, and the routing floor. */
export interface ReplayPlanView {
  planId: string;
  runId: string;
  nodeId: string;
  routing: { localOnly?: boolean; exclude?: string[]; profile?: string };
  estimate: GraphEstimate;
  /** Authorised scope problems: the kernel refuses the replay while there are any. */
  scopeProblems: string[];
}

/**
 * The console's routing choices sent with replay and fork plans. The kernel merges them
 * over the original run's routing and keeps the stricter one (P4-F2).
 */
export function routingOptions(): RunOptions | undefined {
  const o = studio.getState().runOptions;
  const out: RunOptions = {
    ...(o.profile ? { profile: o.profile } : {}),
    ...(o.localOnly ? { localOnly: true } : {}),
    ...(o.exclude?.length ? { exclude: o.exclude } : {}),
    ...(o.allowTest ? { allowTest: true } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

const editParams = (edit: NodeEditInput) => ({
  ...(edit.model ? { model: edit.model } : {}),
  ...(edit.protocol ? { protocol: edit.protocol } : {}),
});

function readPlan(raw: {
  planId: string;
  runId: string;
  nodeId: string;
  routing: { localOnly?: boolean; exclude?: string[]; profile?: string };
  estimate: unknown;
  scope?: { problems: string[] } | undefined;
}): ReplayPlanView {
  const estimate = parseEstimate(raw.estimate, raw);
  if (!estimate) throw new Error(t('error.badPlan'));
  const r = raw.routing;
  return {
    planId: raw.planId,
    runId: raw.runId,
    nodeId: raw.nodeId,
    routing: {
      ...(r.localOnly ? { localOnly: true } : {}),
      ...(r.exclude?.length ? { exclude: r.exclude } : {}),
      ...(r.profile ? { profile: r.profile } : {}),
    },
    estimate,
    scopeProblems: raw.scope?.problems ?? [],
  };
}

const PROFILE: Record<string, Key> = {
  economy: 'onboarding.economy',
  balanced: 'onboarding.balanced',
  performance: 'onboarding.performance',
};

/**
 * The routing a replay is held to, one sentence each: local-only and exclusions say whether
 * they come from the original run or from the console's own setting.
 */
export function routingLines(plan: ReplayPlanView, mine: RunOptions): string[] {
  const r = plan.routing;
  const lines: string[] = [];
  if (r.localOnly)
    lines.push(t(mine.localOnly ? 'replay.routingLocalYours' : 'replay.routingLocalRun'));
  if (r.exclude?.length) {
    const yours = new Set(mine.exclude ?? []);
    const fromRun = r.exclude.filter((p) => !yours.has(p));
    const fromYou = r.exclude.filter((p) => yours.has(p));
    if (fromRun.length)
      lines.push(t('replay.routingExcludeRun', { providers: fromRun.join(', ') }));
    if (fromYou.length)
      lines.push(t('replay.routingExcludeYours', { providers: fromYou.join(', ') }));
  }
  if (!r.localOnly && !r.exclude?.length) lines.push(t('replay.routingOpen'));
  if (r.profile) {
    const key = PROFILE[r.profile];
    lines.push(t('replay.routingProfile', { profile: key ? t(key) : r.profile }));
  }
  return lines;
}

export type PlanOutcome = { ok: true; plan: ReplayPlanView } | { ok: false; error: string };

/** Step 1: what the replay would cost and the routing it is held to; nothing is spent. */
export async function planReplay(
  runId: string,
  nodeId: string,
  edit: NodeEditInput,
): Promise<PlanOutcome> {
  try {
    const options = routingOptions();
    const raw = await call(
      'run.replayPlan',
      { runId, nodeId, ...editParams(edit), ...(options ? { options } : {}) },
      PLAN_TIMEOUT_MS,
    );
    const plan = readPlan(raw);
    const cost = costOf(plan.estimate);
    announce(
      t('replay.announce.planned', {
        id: nodeId,
        expected: formatUsd(cost.expected),
        cap: formatUsd(cost.cap),
      }),
    );
    return { ok: true, plan };
  } catch (e) {
    fail('fail.replayPlan', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const replays = () => studio.getState().replays;

function dropEntry(key: string): void {
  const rest = { ...replays() };
  delete rest[key];
  patch({ replays: rest });
}

/** Step 2: runs the planned replay once; its side-by-side result replaces the pending entry. */
export async function runReplay(plan: ReplayPlanView): Promise<void> {
  const { runId, nodeId, planId } = plan;
  const key = nodeKey(runId, nodeId);
  patch({ replays: { ...replays(), [key]: { pending: true, planId } } });
  announce(t('replay.announce.started', { id: nodeId }));
  try {
    const raw = await call('run.replay', { runId, nodeId, planId }, SPEND_TIMEOUT_MS);
    const parsed = ReplayViewSchema.safeParse(raw);
    if (!parsed.success) throw new Error(t('error.badReplay'));
    const was = replays()[key];
    patch({ replays: { ...replays(), [key]: { pending: false, result: parsed.data } } });
    const r = parsed.data;
    // Cancelled while the node ran: the kernel records what it had, failed (P4-F5).
    if (was?.pending && was.cancelling && !r.replay.ok)
      return announce(t('replay.announce.cancelled', { id: nodeId }));
    announce(
      t('replay.announce.done', {
        id: nodeId,
        model: r.replay.models.map(refKey).join(', ') || '—',
        cost: formatUsd(r.replay.costUsd),
      }),
    );
  } catch (e) {
    const entry = replays()[key];
    dropEntry(key);
    if (entry?.pending && entry.cancelling)
      announce(t('replay.announce.cancelled', { id: nodeId }));
    else fail('fail.replay', e);
  }
}

/**
 * Cancels a running replay by its plan id. Its questions (budget, scope) carry that id as
 * `runId`: they leave the queue and are answered No, like those of a cancelled run (P3-F2).
 */
export async function cancelReplay(runId: string, nodeId: string): Promise<void> {
  const key = nodeKey(runId, nodeId);
  const entry = replays()[key];
  if (!entry?.pending || !entry.planId || entry.cancelling) return;
  patch({ replays: { ...replays(), [key]: { ...entry, cancelling: true } } });
  voidRunConfirms(entry.planId);
  announce(t('replay.announce.cancelling', { id: nodeId }));
  try {
    await call('run.cancel', { runId: entry.planId });
  } catch (e) {
    const now = replays()[key];
    if (now?.pending) patch({ replays: { ...replays(), [key]: { ...now, cancelling: false } } });
    fail('fail.cancel', e);
  }
}
