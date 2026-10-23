/**
 * The console's single store (zustand: ~1 kB, selector subscriptions so a streaming text
 * delta re-renders only the components that read that node).
 */
import { createStore, useStore } from 'zustand';
import type { NotificationName, NotificationParams } from '../rpc/client';
import {
  GraphEstimateSchema,
  GraphEventSchema,
  TaskGraphSchema,
  parseArtifacts,
} from '../rpc/schemas';
import { resolveLocale, setLocale, t, type Key } from '../i18n/core';
import { controlText } from './controls';
import { loadPrefs, savePrefs } from './prefs';
import { applyEvent, applyResult, newRun } from './reducer';
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
  const estimate = GraphEstimateSchema.safeParse(p.estimate);
  if (!graph.success || !estimate.success) return log('warn', t('store.badPlan'));
  updateRun(p.runId, (r) => ({ ...r, graph: graph.data, estimate: estimate.data }));
}

function onDone(p: NotificationParams<'run.done'>): void {
  const artifacts = parseArtifacts(p.artifacts);
  updateRun(p.runId, (r) => ({
    ...applyResult(r, p.result),
    patches: p.patches,
    artifacts,
    ...(p.worktree ? { worktree: p.worktree } : {}),
  }));
  if (p.patches.length) announce(t('run.announce.patches', { count: p.patches.length }));
}

function onControl(p: NotificationParams<'run.control'>): void {
  const entry = { event: p.event, at: Date.now() };
  updateRun(p.runId, (r) => ({ ...r, controls: [...r.controls, entry].slice(-MAX_CONTROLS) }));
  announce(controlText(p.event));
}

function onConfirm(p: NotificationParams<'confirm.request'>): void {
  const confirms = [...studio.getState().confirms, { ...p, receivedAt: Date.now() }];
  studio.setState({ confirms });
  announce(t(`confirm.announce.${p.kind}`));
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
    case 'run.state': {
      const p = params as NotificationParams<'run.state'>;
      updateRun(p.runId, (r) => ({ ...r, state: p.state }));
      return announce(t(STATE_TEXT[p.state]!));
    }
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
  }
}
