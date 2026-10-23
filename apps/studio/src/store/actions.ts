/** User intents → protocol calls. Every call is the only way the console touches the kernel. */
import type { MethodName, Params } from '../rpc/client';
import {
  PlanResultSchema,
  RunStartResultSchema,
  parseModels,
  parseSessions,
  type Ref,
} from '../rpc/schemas';
import { HELP_TEXT, parseInput } from './commands';
import { formatUsd } from './format';
import { newRun } from './reducer';
import { announce, log, patch, studio, updateRun } from './store';

export interface Caller {
  call<M extends MethodName>(method: M, params: Params<M>, timeoutMs?: number): Promise<unknown>;
}

let client: Caller | undefined;

export function setClient(c: Caller | undefined): void {
  client = c;
}

const PLAN_TIMEOUT_MS = 120_000;

function fail(what: string, e: unknown): void {
  const msg = `${what} failed: ${e instanceof Error ? e.message : String(e)}`;
  log('error', msg);
  announce(msg);
}

async function call<M extends MethodName>(
  method: M,
  params: Params<M>,
  timeoutMs?: number,
): Promise<unknown> {
  if (!client) throw new Error('not connected to the kernel');
  return client.call(method, params, timeoutMs);
}

/** Principle "zéro surprise": a request is always planned and shown before it can run. */
export async function requestPlan(request: string): Promise<void> {
  patch({ planning: true });
  try {
    const raw = await call('plan', { request }, PLAN_TIMEOUT_MS);
    const parsed = PlanResultSchema.safeParse(raw);
    if (!parsed.success) throw new Error('the kernel returned a plan this console cannot read');
    const { planId, graph, estimate } = parsed.data;
    patch({ plan: { planId, request, graph, estimate }, selectedNodeId: undefined });
    announce(
      `Plan ready: ${graph.nodes.length} node(s), ${formatUsd(estimate.minUsd)} to ${formatUsd(estimate.totalUsd)}. Press Run to start.`,
    );
  } catch (e) {
    fail('Planning', e);
  } finally {
    patch({ planning: false });
  }
}

export function discardPlan(): void {
  patch({ plan: undefined });
  announce('Plan discarded');
}

export async function startRun(): Promise<void> {
  const plan = studio.getState().plan;
  if (!plan) return;
  try {
    const raw = await call('run.start', { request: plan.request, planId: plan.planId });
    const parsed = RunStartResultSchema.safeParse(raw);
    if (!parsed.success) throw new Error('the kernel did not return a run id');
    const { runId } = parsed.data;
    updateRun(runId, (r) => ({
      ...newRun(runId, plan.request, r.startedAt),
      ...r,
      request: plan.request,
      graph: r.graph ?? plan.graph,
      estimate: r.estimate ?? plan.estimate,
    }));
    patch({ activeRunId: runId, plan: undefined, tab: 'conversation' });
  } catch (e) {
    fail('Starting the run', e);
  }
}

export async function control(kind: 'pause' | 'resume' | 'cancel', runId: string): Promise<void> {
  try {
    await call(`run.${kind}`, { runId });
  } catch (e) {
    fail(`${kind[0]!.toUpperCase()}${kind.slice(1)}`, e);
  }
}

export async function redirectNode(runId: string, nodeId: string, to: Ref): Promise<void> {
  try {
    await call('run.redirect', { runId, nodeId, to });
    announce(`Node ${nodeId} redirected to ${to.provider}/${to.model}`);
  } catch (e) {
    fail('Redirect', e);
  }
}

export async function applyPatches(runId: string, nodeIds?: string[]): Promise<void> {
  try {
    await call('patches.apply', nodeIds ? { runId, nodeIds } : { runId });
    updateRun(runId, (r) => {
      const ids = nodeIds ?? r.patches.map((p) => p.nodeId);
      return { ...r, applied: [...new Set([...r.applied, ...ids])] };
    });
    announce('Patch applied');
  } catch (e) {
    fail('Applying the patch', e);
  }
}

/** Removes the confirmation from the queue first: a second answer is never sent. */
export async function answerConfirm(confirmId: string, ok: boolean): Promise<void> {
  const s = studio.getState();
  if (!s.confirms.some((c) => c.confirmId === confirmId)) return;
  patch({ confirms: s.confirms.filter((c) => c.confirmId !== confirmId) });
  announce(ok ? 'Confirmed' : 'Declined');
  try {
    await call('confirm.answer', { confirmId, ok });
  } catch (e) {
    fail('Answering the confirmation', e);
  }
}

export async function loadSessions(): Promise<void> {
  try {
    patch({ sessions: parseSessions(await call('sessions.list', { limit: 50 })) });
  } catch (e) {
    fail('Loading sessions', e);
  }
}

export async function loadModels(): Promise<void> {
  try {
    patch({ models: parseModels(await call('providers.list', {})) });
  } catch (e) {
    fail('Loading models', e);
  }
}

async function showResult(title: string, method: 'stats' | 'tools.list'): Promise<void> {
  try {
    const result = await call(method, {});
    patch({ notice: { title, body: JSON.stringify(result, null, 2) ?? 'null' } });
  } catch (e) {
    fail(title, e);
  }
}

/** Runs what the user typed in the command bar. Returns false when nothing was done. */
export async function submit(raw: string): Promise<boolean> {
  const p = parseInput(raw);
  if (p.kind === 'empty') return false;
  if (p.kind === 'unknown_command') {
    announce(`Unknown command /${p.name}. Type /help for the list.`);
    return false;
  }
  if (p.kind === 'request') {
    await requestPlan(p.text);
    return true;
  }
  const { name, arg } = p;
  if (name === 'plan') {
    if (!arg) return (announce('Type what to plan after /plan'), false);
    await requestPlan(arg);
  } else if (name === 'run') {
    if (arg) await requestPlan(arg);
    else if (studio.getState().plan) await startRun();
    else return (announce('No plan to run: type a request first'), false);
  } else if (name === 'stats') await showResult('Stats', 'stats');
  else if (name === 'tools') await showResult('Tools', 'tools.list');
  else if (name === 'sessions') await loadSessions();
  else patch({ notice: { title: 'Help', body: HELP_TEXT } });
  return true;
}
