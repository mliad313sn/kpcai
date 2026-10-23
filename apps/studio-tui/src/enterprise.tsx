/**
 * Compact Enterprise view in the terminal (R-5E14): liveness first, then gauges, programs,
 * the team in numbers and the asks waiting for you. Answering an ask needs its evidence,
 * which the web console shows; stop everything is one key (Ctrl+X) here too.
 */
import { Box, Text } from 'ink';
import { useEffect } from 'react';
import { loadSnapshot } from '../../studio/src/enterprise/actions';
import { heartbeatStatus, type Liveness } from '../../studio/src/enterprise/derive';
import { enterprise } from '../../studio/src/enterprise/store';
import { livenessText } from '../../studio/src/enterprise/words';
import { t } from '../../studio/src/i18n/core';
import { useStudio } from '../../studio/src/store/store';
import { useStore } from 'zustand';
import {
  askLine,
  assuranceLine,
  oneLine,
  programLine,
  quotaLine,
  rateLine,
  spendLine,
  teamLines,
} from './enterprise-text';

const MAX_ASKS = 5;
const BEAT: Record<Liveness, { icon: string; color?: string }> = {
  ok: { icon: '●', color: 'green' },
  late: { icon: '◐', color: 'yellow' },
  alert: { icon: '⚠', color: 'yellow' },
  stale: { icon: '⚠', color: 'red' },
  unknown: { icon: '?', color: 'yellow' },
  offline: { icon: '⚠', color: 'red' },
};

function Beat({ now }: { now: number }) {
  const hb = useStore(enterprise, (s) => s.data.heartbeat);
  const connected = useStudio((s) => s.conn === 'open');
  const status = heartbeatStatus(hb, now, connected);
  const look = BEAT[status.level];
  return (
    <Box flexDirection="column">
      <Text {...(look.color ? { color: look.color } : {})} bold={status.level !== 'ok'}>
        {look.icon} {livenessText(status)}
      </Text>
      {status.alerts.slice(0, 3).map((a, i) => (
        <Text key={i} color="yellow">
          {'  '}⚠ “{oneLine(a.text)}”
        </Text>
      ))}
    </Box>
  );
}

function Lines({ lines }: { lines: Array<string | undefined> }) {
  return (
    <>
      {lines
        .filter((l): l is string => !!l)
        .map((l, i) => (
          <Text key={i}>{l}</Text>
        ))}
    </>
  );
}

function Ready({ now }: { now: number }) {
  const d = useStore(enterprise, (s) => s.data);
  return (
    <>
      <Beat now={now} />
      {d.killSwitch ? <Text color="red">{t('tui.ent.killed')}</Text> : null}
      <Lines lines={[spendLine(d), rateLine(d), quotaLine(d), assuranceLine(d)]} />
      <Text bold>{t('tui.ent.programs', { count: d.programs.length })}</Text>
      {d.programs.map((p) => (
        <Text key={p.programId}>
          {'  '}
          {programLine(p)}
        </Text>
      ))}
      <Lines lines={teamLines(d.seats)} />
      <Text bold>{t('tui.ent.inbox', { count: d.inbox.length })}</Text>
      {d.inbox.length === 0 ? <Text dimColor>{t('ent.inbox.empty')}</Text> : null}
      {d.inbox.slice(0, MAX_ASKS).map((i, n) => (
        <Text key={i.escalationId}>
          {'  '}
          {askLine(i, n + 1)}
        </Text>
      ))}
      {d.inbox.length > MAX_ASKS ? (
        <Text dimColor>{t('tui.ent.more', { count: d.inbox.length - MAX_ASKS })}</Text>
      ) : null}
      {d.inbox.length ? <Text dimColor>{t('tui.ent.inboxHint')}</Text> : null}
    </>
  );
}

export function EnterprisePane({ now }: { now: number }) {
  const status = useStore(enterprise, (s) => s.ui.status);
  const error = useStore(enterprise, (s) => s.ui.error);
  const conn = useStudio((s) => s.conn);
  useEffect(() => {
    if (conn === 'open' && status === 'idle') void loadSnapshot();
  }, [conn, status]);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{t('tui.ent.title')}</Text>
      {status === 'ready' ? <Ready now={now} /> : null}
      {status === 'unavailable' ? (
        <Text>
          {t('ent.unavailable.title')}.{' '}
          {t('ent.unavailable.body', { command: 'kpai serve --headless' })}
        </Text>
      ) : null}
      {status === 'error' ? (
        <Text color="red">{t('ent.error.load', { error: oneLine(error ?? '') })}</Text>
      ) : null}
      {status === 'idle' || status === 'loading' ? (
        <Text dimColor>{t('tui.ent.loading')}</Text>
      ) : null}
    </Box>
  );
}
