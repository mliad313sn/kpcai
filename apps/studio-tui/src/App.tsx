/** KP Studio in the terminal (BUILD_PROMPT phase 3): a client of the same kernel server. */
import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { t } from '../../studio/src/i18n/core';
import {
  answerConfirm,
  control,
  discardPlan,
  startRun,
  submit,
} from '../../studio/src/store/actions';
import { studio, useStudio } from '../../studio/src/store/store';
import { keyAction, type Action } from './keys';
import { AgentsPane, Badge, ConfirmPane, ControlPane, PlanPane, ThreadPane } from './views';

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

const LIVE = new Set(['starting', 'running', 'paused']);

function nextNode(): void {
  const s = studio.getState();
  const run = s.activeRunId ? s.runs[s.activeRunId] : undefined;
  const nodes = (s.plan?.graph ?? run?.graph)?.nodes ?? [];
  if (nodes.length === 0) return;
  const i = nodes.findIndex((n) => n.id === s.selectedNodeId);
  studio.setState({ selectedNodeId: nodes[(i + 1) % nodes.length]!.id });
}

/** Runs an action on the shared store; returns the new request-line text. */
export function perform(a: Action, text: string, exit: () => void): string {
  const s = studio.getState();
  const run = s.activeRunId ? s.runs[s.activeRunId] : undefined;
  switch (a.kind) {
    case 'type':
      return text + a.text;
    case 'backspace':
      return text.slice(0, -1);
    case 'submit':
      if (text.trim()) void submit(text);
      return text.trim() ? '' : text;
    case 'run':
      if (s.plan) void startRun();
      break;
    case 'discard':
      if (s.plan) discardPlan();
      break;
    case 'pauseResume':
      if (run && LIVE.has(run.state))
        void control(run.state === 'paused' ? 'resume' : 'pause', run.runId);
      break;
    case 'cancel':
      if (run && LIVE.has(run.state)) void control('cancel', run.runId);
      break;
    case 'nextNode':
      nextNode();
      break;
    case 'confirm':
      if (s.confirms[0]) void answerConfirm(s.confirms[0].confirmId, a.ok);
      break;
    case 'quit':
      exit();
      break;
  }
  return text;
}

/** Silence is a no: the oldest confirmation is declined when its time is up. */
function useConfirmTimeout(): void {
  const c = useStudio((s) => s.confirms[0]);
  useEffect(() => {
    if (!c) return;
    const timer = setTimeout(
      () => void answerConfirm(c.confirmId, false),
      c.receivedAt + c.timeoutMs - Date.now(),
    );
    return () => clearTimeout(timer);
  }, [c]);
}

function Selected() {
  const id = useStudio((s) => s.selectedNodeId);
  const reason = useStudio((s) => {
    const run = s.activeRunId ? s.runs[s.activeRunId] : undefined;
    const est = (s.plan?.estimate ?? run?.estimate)?.nodes.find((n) => n.nodeId === id);
    return (id && run?.nodes[id]?.reason) ?? est?.reason;
  });
  if (!id) return null;
  return <Text>{t('tui.selected', { id, reason: reason ?? t('routing.none') })}</Text>;
}

export function TuiApp() {
  const { exit } = useApp();
  const [text, setText] = useState('');
  const now = useNow();
  const conn = useStudio((s) => s.conn);
  const plan = useStudio((s) => s.plan);
  const run = useStudio((s) => (s.activeRunId ? s.runs[s.activeRunId] : undefined));
  const confirm = useStudio((s) => s.confirms[0]);
  const selected = useStudio((s) => s.selectedNodeId);
  const last = useStudio((s) => s.announcement.text);
  useConfirmTimeout();
  useInput((input, key) => {
    setText((current) => perform(keyAction(input, key, !!confirm), current, exit));
  });
  return (
    <Box flexDirection="column">
      <Text bold>
        {t('tui.title')} · {t(`conn.${conn}`)}
      </Text>
      {confirm ? <ConfirmPane c={confirm} now={now} /> : null}
      {plan ? <PlanPane plan={plan} {...(selected ? { selected } : {})} /> : null}
      {!plan && run ? <ThreadPane run={run} {...(selected ? { selected } : {})} /> : null}
      {!plan && !run ? <Text dimColor>{t('tui.noPlan')}</Text> : null}
      <AgentsPane run={run} now={now} />
      {run ? <ControlPane run={run} /> : null}
      <Selected />
      <Text>
        {t('tui.prompt')} › {text || <Text dimColor>{t('tui.placeholder')}</Text>}
      </Text>
      {last ? <Text dimColor>{last}</Text> : null}
      <Text dimColor>{t('tui.keys')}</Text>
      {run ? null : <Badge state={plan ? 'planned' : 'pending'} />}
    </Box>
  );
}
