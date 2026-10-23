/**
 * What a key does in KP Studio in the terminal, over the same store and actions as the web
 * console. The input line is a request by default; Ctrl+N and Ctrl+T make it an instruction
 * or a redirect for the selected node (R-304, principle 4), Esc makes it a request again.
 */
import { t } from '../../studio/src/i18n/core';
import {
  answerConfirm,
  applyPatches,
  control,
  discardPlan,
  instructNode,
  loadModels,
  redirectNode,
  startRun,
  submit,
} from '../../studio/src/store/actions';
import { isTerminal } from '../../studio/src/store/reducer';
import { announce, studio } from '../../studio/src/store/store';
import type { RunView } from '../../studio/src/store/types';
import type { Action } from './keys';

export interface TuiLine {
  mode: 'request' | 'instruct' | 'redirect';
  text: string;
  /** Node the instruction or redirect is for. */
  nodeId?: string;
  /** The diff view replaces the plan or thread pane. */
  diff: boolean;
}

export const EMPTY_LINE: TuiLine = { mode: 'request', text: '', diff: false };

const LIVE = new Set(['starting', 'running', 'paused']);

function activeRun(): RunView | undefined {
  const s = studio.getState();
  return s.activeRunId ? s.runs[s.activeRunId] : undefined;
}

function nextNode(): void {
  const s = studio.getState();
  const nodes = (s.plan?.graph ?? activeRun()?.graph)?.nodes ?? [];
  if (nodes.length === 0) return;
  const i = nodes.findIndex((n) => n.id === s.selectedNodeId);
  studio.setState({ selectedNodeId: nodes[(i + 1) % nodes.length]!.id });
}

/** The selected node of the live run when it can be steered that way; announces why not. */
function steerTarget(kind: 'instruct' | 'redirect'): { run: RunView; nodeId: string } | undefined {
  const run = activeRun();
  const nodeId = studio.getState().selectedNodeId;
  if (!run || !LIVE.has(run.state)) return void announce(t('tui.steerNoRun'));
  if (!nodeId || !run.graph?.nodes.some((n) => n.id === nodeId))
    return void announce(t('tui.steerSelect'));
  const state = run.nodes[nodeId]?.state;
  if (kind === 'instruct' && state && state !== 'pending')
    return void announce(t('tui.instructStarted', { id: nodeId }));
  if (kind === 'redirect' && state && isTerminal(state))
    return void announce(t('tui.redirectFinished', { id: nodeId }));
  return { run, nodeId };
}

function steer(kind: 'instruct' | 'redirect', line: TuiLine): TuiLine {
  const target = steerTarget(kind);
  if (!target) return line;
  if (kind === 'redirect') void loadModels();
  return { ...line, mode: kind, nodeId: target.nodeId, text: '', diff: false };
}

function sendLine(line: TuiLine): TuiLine {
  const text = line.text.trim();
  const run = activeRun();
  if (line.mode === 'request') {
    if (text) void submit(text);
    return text ? { ...line, text: '', diff: false } : line;
  }
  if (!text || !run || !line.nodeId) return line;
  if (line.mode === 'instruct') {
    const id = line.nodeId;
    void instructNode(run.runId, id, text).then((ok) => {
      if (ok) announce(t('steer.sent', { id }));
    });
    return EMPTY_LINE;
  }
  const [provider, ...rest] = text.split('/');
  const model = rest.join('/');
  if (!provider || !model) return (announce(t('tui.redirectBad')), line);
  void redirectNode(run.runId, line.nodeId, { provider, model });
  return EMPTY_LINE;
}

function apply(): void {
  const run = activeRun();
  const pending = run?.patches.filter((p) => !run.applied.includes(p.nodeId)) ?? [];
  if (!run || pending.length === 0) return announce(t('tui.noPatches'));
  void applyPatches(
    run.runId,
    pending.map((p) => p.nodeId),
  );
}

function runControl(a: Action): void {
  const s = studio.getState();
  const run = activeRun();
  const live = run && LIVE.has(run.state);
  if (a.kind === 'run' && s.plan) void startRun();
  else if (a.kind === 'discard' && s.plan) discardPlan();
  else if (a.kind === 'pauseResume' && live)
    void control(run.state === 'paused' ? 'resume' : 'pause', run.runId);
  else if (a.kind === 'cancel' && live) void control('cancel', run.runId);
  else if (a.kind === 'confirm' && s.confirms[0]) void answerConfirm(s.confirms[0].confirmId, a.ok);
}

/** Runs one key's action on the shared store; returns the new input line. */
export function perform(a: Action, line: TuiLine, exit: () => void): TuiLine {
  switch (a.kind) {
    case 'type':
      return { ...line, text: line.text + a.text };
    case 'backspace':
      return { ...line, text: line.text.slice(0, -1) };
    case 'submit':
      return sendLine(line);
    case 'escape':
      return line.mode !== 'request' ? EMPTY_LINE : { ...line, diff: false };
    case 'diff':
      return { ...line, diff: !line.diff };
    case 'apply':
      apply();
      return { ...line, diff: true };
    case 'instruct':
    case 'redirect':
      return steer(a.kind, line);
    case 'nextNode':
      nextNode();
      return line;
    case 'quit':
      exit();
      return line;
    default:
      runControl(a);
      return line;
  }
}
