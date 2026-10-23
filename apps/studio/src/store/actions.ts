/** User intents → protocol calls. Every call is the only way the console touches the kernel. */
import type { MethodName, MethodResult, Params } from '../rpc/client';
import {
  PlanResultSchema,
  parseEstimate,
  parseModels,
  parseProviders,
  parseSessions,
  serverAllowsTest,
  type Ref,
} from '../rpc/schemas';
import { t, type Key } from '../i18n/core';
import { helpText, parseInput } from './commands';
import { costOf } from './cost';
import { formatUsd } from './format';
import { newRun } from './reducer';
import { announce, log, patch, setDecliner, studio, updateRun } from './store';
import type { PlanView, StudioState } from './types';

/** Set by the memory module: reloads the proposals once a memory question is answered. */
let afterMemoryAnswer: (layer: 'user' | 'project' | 'session') => void = () => undefined;

export function onMemoryAnswer(fn: (layer: 'user' | 'project' | 'session') => void): void {
  afterMemoryAnswer = fn;
}

export interface Caller {
  call<M extends MethodName>(
    method: M,
    params: Params<M>,
    timeoutMs?: number,
  ): Promise<MethodResult<M>>;
}

let client: Caller | undefined;

export function setClient(c: Caller | undefined): void {
  client = c;
}

const PLAN_TIMEOUT_MS = 120_000;

/** `key` is a whole sentence with an `{error}` slot (the kernel's message, untranslated). */
export function fail(key: Key, e: unknown): void {
  const msg = t(key, { error: e instanceof Error ? e.message : String(e) });
  log('error', msg);
  announce(msg);
}

export async function call<M extends MethodName>(
  method: M,
  params: Params<M>,
  timeoutMs?: number,
): Promise<MethodResult<M>> {
  if (!client) throw new Error(t('error.notConnected'));
  return client.call(method, params, timeoutMs);
}

/** Principle "zéro surprise": a request is always planned and shown before it can run. */
export async function requestPlan(
  request: string,
  extra: { skill?: string | undefined; agent?: string | undefined } = {},
): Promise<void> {
  patch({ planning: true });
  try {
    // A ticket's skill and agent (R-502) only narrow; they ride with this plan and its run.
    const options = { ...studio.getState().runOptions, ...definedOnly(extra) };
    const raw = await call('plan', { request, options }, PLAN_TIMEOUT_MS);
    const parsed = PlanResultSchema.safeParse(raw);
    if (!parsed.success) throw new Error(t('error.badPlan'));
    const { planId, graph } = parsed.data;
    const estimate = parseEstimate(raw.estimate, raw) ?? parsed.data.estimate;
    const plan = {
      planId,
      request,
      graph,
      original: graph,
      estimate,
      checking: false,
      ...(raw.rules ? { rules: raw.rules } : {}),
      ...(raw.packs ? { packs: raw.packs } : {}),
      ...(raw.scope ? { scope: raw.scope } : {}),
      ...(raw.memory ? { memory: raw.memory } : {}),
      ...(extra.skill || extra.agent ? { options } : {}),
    };
    patch({ plan, selectedNodeId: undefined });
    const cost = costOf(estimate);
    announce(
      t('plan.announce.ready', {
        count: graph.nodes.length,
        expected: formatUsd(cost.expected),
        cap: formatUsd(cost.cap),
      }),
    );
  } catch (e) {
    fail('fail.plan', e);
  } finally {
    patch({ planning: false });
  }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function discardPlan(): void {
  patch({ plan: undefined });
  announce(t('plan.announce.discarded'));
}

/** True when the user changed the proposal: the edited graph is then sent with Run. */
export function isEdited(plan: { graph: { nodes: unknown[] }; original: { nodes: unknown[] } }) {
  return JSON.stringify(plan.graph.nodes) !== JSON.stringify(plan.original.nodes);
}

/** Starts the plan: `run.fork` for a fork plan (R-403), else `run.start` with any edits. */
async function launch(plan: PlanView, s: StudioState): Promise<string> {
  if (plan.fork) return (await call('run.fork', { planId: plan.planId })).runId;
  const { runId } = await call('run.start', {
    request: plan.request,
    planId: plan.planId,
    ...(isEdited(plan) ? { graph: { nodes: plan.graph.nodes } } : {}),
    options: plan.options ?? s.runOptions,
  });
  return runId;
}

/** R-301: the approved plan is the one that runs; the kernel validates the edits again. */
export async function startRun(): Promise<void> {
  const s = studio.getState();
  const plan = s.plan;
  if (!plan) return;
  try {
    const runId = await launch(plan, s);
    updateRun(runId, (r) => ({
      ...newRun(runId, plan.request, r.startedAt),
      ...r,
      request: plan.request,
      graph: r.graph ?? plan.graph,
      estimate: r.estimate ?? plan.estimate,
      ...(plan.fork ? { forkOf: plan.fork.parent } : {}),
    }));
    patch({ activeRunId: runId, plan: undefined, tab: 'conversation' });
  } catch (e) {
    fail('fail.start', e);
  }
}

export async function control(kind: 'pause' | 'resume' | 'cancel', runId: string): Promise<void> {
  try {
    if (kind === 'cancel') await call('run.cancel', { runId });
    else await call(`run.${kind}`, { runId });
  } catch (e) {
    fail(`fail.${kind}`, e);
  }
}

export async function redirectNode(runId: string, nodeId: string, to: Ref): Promise<void> {
  try {
    await call('run.redirect', { runId, nodeId, to });
    announce(t('node.announce.redirected', { id: nodeId, model: `${to.provider}/${to.model}` }));
  } catch (e) {
    fail('fail.redirect', e);
  }
}

/** R-304: an instruction for a node that has not started yet. */
export async function instructNode(runId: string, nodeId: string, text: string): Promise<boolean> {
  try {
    await call('run.instruct', { runId, nodeId, text });
    return true;
  } catch (e) {
    fail('fail.instruct', e);
    return false;
  }
}

/** Each patch is confirmed with its diff by the kernel; only those that applied are marked. */
export async function applyPatches(runId: string, nodeIds?: string[]): Promise<void> {
  try {
    const { results } = await call('patches.apply', nodeIds ? { runId, nodeIds } : { runId });
    const ok = results.filter((r) => r.ok).map((r) => r.nodeId);
    updateRun(runId, (r) => ({ ...r, applied: [...new Set([...r.applied, ...ok])] }));
    const failed = results.filter((r) => !r.ok);
    for (const f of failed)
      log('warn', t('patch.notApplied', { id: f.nodeId, message: f.message }));
    announce(
      failed.length
        ? t('patch.announce.partial', { count: ok.length, failed: failed.length })
        : t('patch.announce.applied', { count: ok.length }),
    );
  } catch (e) {
    fail('fail.apply', e);
  }
}

/**
 * A confirmation the console dropped because its run was cancelled (P3-F2) is answered No.
 * The kernel may have closed it already: a refusal or "not accepted" is expected, not shown.
 */
setDecliner((confirmId) => {
  call('confirm.answer', { confirmId, ok: false }).catch(() => undefined);
});

/**
 * Removes the confirmation from the queue first: a second answer is never sent. A dispute
 * is settled only by `ok` with one of its option ids (`choice`); anything else rejects.
 */
export async function answerConfirm(
  confirmId: string,
  ok: boolean,
  choice?: string,
): Promise<void> {
  const s = studio.getState();
  const c = s.confirms.find((x) => x.confirmId === confirmId);
  if (!c) return;
  patch({ confirms: s.confirms.filter((x) => x.confirmId !== confirmId) });
  const yes = ok && (c.kind !== 'dispute' || choice !== undefined);
  announce(t(yes ? 'confirm.announce.yes' : 'confirm.announce.no'));
  try {
    await call('confirm.answer', { confirmId, ok: yes, ...(yes && choice ? { choice } : {}) });
  } catch (e) {
    fail('fail.answer', e);
  }
  if (c.kind === 'memory' && c.memory) afterMemoryAnswer(c.memory.layer);
}

export async function loadSessions(): Promise<void> {
  try {
    patch({ sessions: parseSessions(await call('sessions.list', { limit: 50 })) });
  } catch (e) {
    fail('fail.sessions', e);
  }
}

/** Providers (onboarding) and the models offered for a node (plan editor, redirect). */
export async function loadModels(): Promise<void> {
  try {
    const raw = await call('providers.list', {});
    const testAllowed = serverAllowsTest(raw) || studio.getState().runOptions.allowTest === true;
    patch({ providers: parseProviders(raw), testAllowed, models: parseModels(raw, testAllowed) });
  } catch (e) {
    fail('fail.models', e);
  }
}

async function showResult(method: 'stats' | 'tools.list'): Promise<void> {
  const stats = method === 'stats';
  try {
    const result = await call(method, {});
    const title = t(stats ? 'notice.stats' : 'notice.tools');
    patch({ notice: { title, body: JSON.stringify(result, null, 2) ?? 'null' } });
  } catch (e) {
    fail(stats ? 'fail.stats' : 'fail.tools', e);
  }
}

/** Runs what the user typed in the command bar. Returns false when nothing was done. */
export async function submit(raw: string): Promise<boolean> {
  const p = parseInput(raw);
  if (p.kind === 'empty') return false;
  if (p.kind === 'unknown_command') {
    announce(t('command.unknown', { name: p.name }));
    return false;
  }
  if (p.kind === 'request') {
    await requestPlan(p.text);
    return true;
  }
  const { name, arg } = p;
  if (name === 'plan') {
    if (!arg) return (announce(t('command.planEmpty')), false);
    await requestPlan(arg);
  } else if (name === 'run') {
    if (arg) await requestPlan(arg);
    else if (studio.getState().plan) await startRun();
    else return (announce(t('command.noPlan')), false);
  } else if (name === 'stats') await showResult('stats');
  else if (name === 'tools') await showResult('tools.list');
  else if (name === 'sessions') await loadSessions();
  else patch({ notice: { title: t('notice.help'), body: helpText() } });
  return true;
}
