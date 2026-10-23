/** KP Studio in the terminal (BUILD_PROMPT phase 3): a client of the same kernel server. */
import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { t } from '../../studio/src/i18n/core';
import { answerConfirm } from '../../studio/src/store/actions';
import { refKey } from '../../studio/src/store/reducer';
import { patch, useStudio } from '../../studio/src/store/store';
import { keyAction } from './keys';
import { EMPTY_LINE, perform, type TuiLine } from './perform';
import {
  AgentsPane,
  Badge,
  ConfirmPane,
  ControlPane,
  DiffPane,
  PlanPane,
  ThreadPane,
} from './views';

export { perform } from './perform';

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
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

const MAX_MODELS = 8;

/** The input line: a request, or an instruction or redirect for the selected node. */
function InputLine({ line }: { line: TuiLine }) {
  const models = useStudio((s) => s.models);
  const id = line.nodeId ?? '';
  const [label, hint] =
    line.mode === 'instruct'
      ? [t('tui.instructPrompt', { id }), t('tui.instructPlaceholder')]
      : line.mode === 'redirect'
        ? [t('tui.redirectPrompt', { id }), t('tui.redirectPlaceholder')]
        : [t('tui.prompt'), t('tui.placeholder')];
  return (
    <Box flexDirection="column">
      {line.mode === 'redirect' && models.length > 0 ? (
        <Text dimColor>
          {t('tui.models', {
            models: models.slice(0, MAX_MODELS).map(refKey).join(', '),
            count: models.length,
          })}
        </Text>
      ) : null}
      <Text>
        {label} › {line.text || <Text dimColor>{hint}</Text>}
      </Text>
    </Box>
  );
}

export function TuiApp() {
  const { exit } = useApp();
  const [line, setLine] = useState<TuiLine>(EMPTY_LINE);
  const now = useNow();
  const conn = useStudio((s) => s.conn);
  const plan = useStudio((s) => s.plan);
  const run = useStudio((s) => (s.activeRunId ? s.runs[s.activeRunId] : undefined));
  const confirm = useStudio((s) => s.confirms[0]);
  const selected = useStudio((s) => s.selectedNodeId);
  const last = useStudio((s) => s.announcement.text);
  useConfirmTimeout();
  // Announcements name terminal keys, not web tabs (e.g. patches ready: Ctrl+O, Ctrl+A).
  useEffect(() => patch({ surface: 'tui' }), []);
  useInput((input, key) => {
    setLine((current) => perform(keyAction(input, key, !!confirm), current, exit));
  });
  const showDiff = line.diff && !plan;
  return (
    <Box flexDirection="column">
      <Text bold>
        {t('tui.title')} · {t(`conn.${conn}`)}
      </Text>
      {confirm ? <ConfirmPane c={confirm} now={now} /> : null}
      {plan ? <PlanPane plan={plan} {...(selected ? { selected } : {})} /> : null}
      {showDiff ? <DiffPane run={run} /> : null}
      {!plan && !showDiff && run ? (
        <ThreadPane run={run} {...(selected ? { selected } : {})} />
      ) : null}
      {!plan && !run && !showDiff ? <Text dimColor>{t('tui.noPlan')}</Text> : null}
      <AgentsPane run={run} now={now} />
      {run ? <ControlPane run={run} /> : null}
      <Selected />
      <InputLine line={line} />
      {last ? <Text dimColor>{last}</Text> : null}
      <Text dimColor>{t('tui.keys')}</Text>
      {run ? null : <Badge state={plan ? 'planned' : 'pending'} />}
    </Box>
  );
}
