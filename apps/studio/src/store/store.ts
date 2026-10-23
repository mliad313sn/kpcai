/**
 * The console's single store (zustand: ~1 kB, selector subscriptions so a streaming text
 * delta re-renders only the components that read that node).
 */
import { createStore, useStore } from 'zustand';
import type { NotificationName, NotificationParams } from '../rpc/client';
import { GraphEventSchema, TaskGraphSchema, parseArtifacts, parseEstimate } from '../rpc/schemas';
import { resolveLocale, setLocale, t, type Key } from '../i18n/core';
import { parseDisputeRecords, parseReused, parseVerification } from '../rpc/learning-schemas';
import { controlText } from './controls';
import { applyDisputeControl, applyDisputeRecords } from './disputes';
import { loadPrefs, savePrefs } from './prefs';
import { applyEvent, applyResult, blankNode, newRun } from './reducer';
import type { RunView, StudioState } from './types';

const MAX_LOGS = 200;
const MAX_CONTROLS = 200;

export function initialState(): StudioState {
  const prefs = loadPrefs();
  setLocale(resolveLocale(prefs.locale));
  return {
    conn: 'idle',
    planning: false,
    runs: {},
    sessions: [],
    providers: [],
    testAllowed: false,
    models: [],
    runOptions: { profile: prefs.profile, ...(prefs.localOnly ? { localOnly: true } : {}) },
    onboardingOpen: false,
    packs: [],
    serverRuns: [],
    checkpoints: {},
    savedArtifacts: [],
    confirms: [],
    logs: [],
    announcement: { text: '', seq: 0 },
    tab: 'conversation',
    paletteOpen: false,
    prefs,
    surface: 'web',
    memory: { layers: {}, pending: [], loading: false },
    evidence: { loading: false },
    replays: {},
    grades: {},
  };
}

export const studio = createStore<StudioState>(() => initialState());

export function useStudio<T>(selector: (s: StudioState) => T): T {
  return useStore(studio, selector);
}

export function patch(p: Partial<StudioState>): void {
  studio.setState(p);
}

export function announce(text: string): void {
  const a = studio.getState().announcement;
  studio.setState({ announcement: { text, seq: a.seq + 1 } });
}

export function log(level: 'info' | 'warn' | 'error', message: string): void {
  const logs = [...studio.getState().logs, { level, message, at: Date.now() }].slice(-MAX_LOGS);
  studio.setState({ logs });
}

export function setPrefs(update: (p: StudioState['prefs']) => StudioState['prefs']): void {
  const prefs = update(studio.getState().prefs);
  savePrefs(prefs);
  setLocale(resolveLocale(prefs.locale));
  studio.setState({ prefs });
}

/** Updates (or lazily creates, if events arrive before `run.start` answers) a run. */
export function updateRun(runId: string, f: (r: RunView) => RunView): void {
  const s = studio.getState();
  const run = s.runs[runId] ?? newRun(runId, s.plan?.request ?? '', Date.now());
  studio.setState({ runs: { ...s.runs, [runId]: f(run) } });
}

const STATE_TEXT: Record<string, Key> = {
  running: 'run.announce.running',
  paused: 'run.announce.paused',
  cancelling: 'run.announce.cancelling',
  done: 'run.announce.done',
  failed: 'run.announce.failed',
  cancelled: 'run.announce.cancelled',
};

function onRunEvent(p: NotificationParams<'run.event'>): void {
  const parsed = GraphEventSchema.safeParse(p.event);
  if (!parsed.success) return log('warn', t('store.badEvent'));
  const e = parsed.data;
  updateRun(p.runId, (r) => applyEvent(r, e, Date.now()));
  if (e.type === 'node_state' && (e.state === 'done' || e.state === 'failed'))
    announce(
      t(e.state === 'done' ? 'node.announce.done' : 'node.announce.failed', { id: e.nodeId }),
    );
}

function onPlanned(p: NotificationParams<'run.planned'>): void {
  const graph = TaskGraphSchema.safeParse(p.graph);
  const estimate = parseEstimate(p.estimate, p);
  if (!graph.success || !estimate) return log('warn', t('store.badPlan'));
  updateRun(p.runId, (r) => ({ ...r, graph: graph.data, estimate }));
}

/** A fork's reused nodes ran in the parent run: they are shown done, never billed again. */
function markReused(r: RunView, reused: string[]): RunView {
  if (reused.length === 0) return r;
  const nodes = { ...r.nodes };
  for (const id of reused) {
    const n = nodes[id] ?? blankNode();
    if (n.state === 'pending') nodes[id] = { ...n, state: 'done' };
  }
  return { ...r, nodes, reused };
}

function onDone(p: NotificationParams<'run.done'>): void {
  const artifacts = parseArtifacts(p.artifacts);
  const verification = parseVerification(p.verification);
  const records = parseDisputeRecords(p.result);
  const reused = parseReused(p.result);
  updateRun(p.runId, (r) => ({
    ...markReused(applyDisputeRecords(applyResult(r, p.result), records), reused),
    patches: p.patches,
    artifacts,
    ...(p.worktree ? { worktree: p.worktree } : {}),
    ...(verification ? { verification } : {}),
  }));
  const key = studio.getState().surface === 'tui' ? 'tui.announce.patches' : 'run.announce.patches';
  if (p.patches.length) announce(t(key, { count: p.patches.length }));
}

function onControl(p: NotificationParams<'run.control'>): void {
  const entry = { event: p.event, at: Date.now() };
  updateRun(p.runId, (r) =>
    applyDisputeControl({ ...r, controls: [...r.controls, entry].slice(-MAX_CONTROLS) }, p.event),
  );
  announce(controlText(p.event));
}

/** Sends a No for a confirmation the console dropped; set by the actions module. */
let decline: (confirmId: string) => void = () => undefined;

export function setDecliner(fn: (confirmId: string) => void): void {
  decline = fn;
}

function stopping(runId: string | undefined): boolean {
  const state = runId ? studio.getState().runs[runId]?.state : undefined;
  return state === 'cancelling' || state === 'cancelled';
}

/**
 * Review P3-F2: once a run is cancelling, none of its confirmations can be answered Yes.
 * Its open dialog and queued confirmations are removed (a late click finds nothing to
 * answer), each is answered No, and the live region says so.
 */
export function voidRunConfirms(runId: string): boolean {
  const s = studio.getState();
  const gone = s.confirms.filter((c) => c.runId === runId);
  if (!gone.length) return false;
  studio.setState({ confirms: s.confirms.filter((c) => c.runId !== runId) });
  for (const c of gone) decline(c.confirmId);
  announce(t('confirm.announce.voided', { count: gone.length }));
  return true;
}

/**
 * The kernel closed a confirmation itself (for example when its run is cancelled). Any
 * notice of this shape is accepted, whatever its name: the confirmation leaves the queue
 * without an answer, since the kernel no longer waits for one.
 */
export function confirmWithdrawn(params: unknown): void {
  const id = (params as { confirmId?: unknown } | null)?.confirmId;
  if (typeof id !== 'string') return;
  const s = studio.getState();
  if (!s.confirms.some((c) => c.confirmId === id)) return;
  studio.setState({ confirms: s.confirms.filter((c) => c.confirmId !== id) });
  announce(t('confirm.announce.closed'));
}

function onConfirm(p: NotificationParams<'confirm.request'>): void {
  if (stopping(p.runId)) {
    decline(p.confirmId);
    return announce(t('confirm.announce.voided', { count: 1 }));
  }
  const confirms = [...studio.getState().confirms, { ...p, receivedAt: Date.now() }];
  studio.setState({ confirms });
  announce(t(`confirm.announce.${p.kind}`));
}

function onState(p: NotificationParams<'run.state'>): void {
  updateRun(p.runId, (r) => ({ ...r, state: p.state }));
  const voided = (p.state === 'cancelling' || p.state === 'cancelled') && voidRunConfirms(p.runId);
  if (!voided) announce(t(STATE_TEXT[p.state]!));
}

/** Entry point for every validated server notification. */
export function handleNotification<N extends NotificationName>(
  name: N,
  params: NotificationParams<N>,
): void {
  switch (name) {
    case 'run.event':
      return onRunEvent(params as NotificationParams<'run.event'>);
    case 'run.planned':
      return onPlanned(params as NotificationParams<'run.planned'>);
    case 'run.state':
      return onState(params as NotificationParams<'run.state'>);
    case 'run.done':
      return onDone(params as NotificationParams<'run.done'>);
    case 'run.control':
      return onControl(params as NotificationParams<'run.control'>);
    case 'confirm.request':
      return onConfirm(params as NotificationParams<'confirm.request'>);
    case 'log': {
      const p = params as NotificationParams<'log'>;
      return log(p.level, p.message);
    }
    default:
      // A newer kernel's notice about a confirmation (P3-F2): taken leniently.
      if (String(name).startsWith('confirm.')) return confirmWithdrawn(params);
  }
}
