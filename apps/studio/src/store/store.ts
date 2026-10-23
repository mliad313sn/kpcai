/**
 * The console's single store (zustand: ~1 kB, selector subscriptions so a streaming text
 * delta re-renders only the components that read that node).
 */
import { createStore, useStore } from 'zustand';
import type { NotificationName, NotificationParams } from '../rpc/client';
import { GraphEstimateSchema, GraphEventSchema, TaskGraphSchema } from '../rpc/schemas';
import { loadPrefs, savePrefs } from './prefs';
import { applyEvent, applyResult, newRun } from './reducer';
import type { RunView, StudioState } from './types';

const MAX_LOGS = 200;

export function initialState(): StudioState {
  return {
    conn: 'idle',
    planning: false,
    runs: {},
    sessions: [],
    models: [],
    confirms: [],
    logs: [],
    announcement: { text: '', seq: 0 },
    tab: 'conversation',
    paletteOpen: false,
    prefs: loadPrefs(),
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
  studio.setState({ prefs });
}

/** Updates (or lazily creates, if events arrive before `run.start` answers) a run. */
export function updateRun(runId: string, f: (r: RunView) => RunView): void {
  const s = studio.getState();
  const run = s.runs[runId] ?? newRun(runId, s.plan?.request ?? '', Date.now());
  studio.setState({ runs: { ...s.runs, [runId]: f(run) } });
}

const STATE_TEXT: Record<string, string> = {
  running: 'Run started',
  paused: 'Run paused',
  cancelling: 'Cancelling run',
  done: 'Run finished',
  failed: 'Run failed',
  cancelled: 'Run cancelled',
};

function onRunEvent(p: NotificationParams<'run.event'>): void {
  const parsed = GraphEventSchema.safeParse(p.event);
  if (!parsed.success) return log('warn', 'Dropped a malformed run event');
  const e = parsed.data;
  updateRun(p.runId, (r) => applyEvent(r, e, Date.now()));
  if (e.type === 'node_state' && (e.state === 'done' || e.state === 'failed'))
    announce(`Node ${e.nodeId} ${e.state}`);
}

function onPlanned(p: NotificationParams<'run.planned'>): void {
  const graph = TaskGraphSchema.safeParse(p.graph);
  const estimate = GraphEstimateSchema.safeParse(p.estimate);
  if (!graph.success || !estimate.success) return log('warn', 'Dropped a malformed plan');
  updateRun(p.runId, (r) => ({ ...r, graph: graph.data, estimate: estimate.data }));
}

function onDone(p: NotificationParams<'run.done'>): void {
  updateRun(p.runId, (r) => ({ ...applyResult(r, p.result), patches: p.patches }));
  if (p.patches.length) announce(`${p.patches.length} patch(es) ready in the Diff tab`);
}

function onConfirm(p: NotificationParams<'confirm.request'>): void {
  const confirms = [...studio.getState().confirms, { ...p, receivedAt: Date.now() }];
  studio.setState({ confirms });
  announce(`Confirmation needed: ${p.kind}`);
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
      return announce(STATE_TEXT[p.state] ?? `Run ${p.state}`);
    }
    case 'run.done':
      return onDone(params as NotificationParams<'run.done'>);
    case 'confirm.request':
      return onConfirm(params as NotificationParams<'confirm.request'>);
    case 'log': {
      const p = params as NotificationParams<'log'>;
      return log(p.level, p.message);
    }
  }
}
