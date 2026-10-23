/**
 * The panes of KP Studio in the terminal, over the same store as the web console. Model
 * output is shown as plain text (Ink renders strings, never markup); states always carry a
 * word and an icon, colour only reinforces them.
 */
import { Box, Text } from 'ink';
import { t, type Key } from '../../studio/src/i18n/core';
import { controlText } from '../../studio/src/store/controls';
import { formatDuration, formatRange, formatUsd } from '../../studio/src/store/format';
import { refKey } from '../../studio/src/store/reducer';
import type { ConfirmView, NodeRun, PlanView, RunView } from '../../studio/src/store/types';

const STATE: Record<string, { icon: string; key: Key; color?: string }> = {
  planned: { icon: '◇', key: 'state.planned' },
  pending: { icon: '○', key: 'state.waiting' },
  starting: { icon: '◌', key: 'state.starting' },
  running: { icon: '▶', key: 'state.running', color: 'cyan' },
  review: { icon: '◑', key: 'state.in_review', color: 'cyan' },
  paused: { icon: '❚❚', key: 'state.paused', color: 'yellow' },
  cancelling: { icon: '⊘', key: 'state.cancelling', color: 'yellow' },
  done: { icon: '✓', key: 'state.done', color: 'green' },
  failed: { icon: '✕', key: 'state.failed', color: 'red' },
  skipped: { icon: '↷', key: 'state.skipped' },
  cancelled: { icon: '⊘', key: 'state.cancelled', color: 'yellow' },
};

export function Badge({ state }: { state: string }) {
  const s = STATE[state] ?? STATE.pending!;
  return (
    <Text {...(s.color ? { color: s.color } : {})}>
      {s.icon} {t(s.key)}
    </Text>
  );
}

function bandText(p: { estimate: PlanView['estimate'] }): string {
  const e = p.estimate;
  const band = e.band ?? { lowUsd: e.minUsd, highUsd: e.totalUsd, basis: 'heuristic' as const };
  return t('cost.band', {
    range: formatRange(band.lowUsd, band.highUsd),
    basis: t(`cost.basis.${band.basis}`),
    cap: formatUsd(e.totalUsd),
  });
}

/** R-301/R-302 in the terminal: nodes, who would do them, the band and the cap. */
export function PlanPane({ plan, selected }: { plan: PlanView; selected?: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        {t('tui.plan')} · {bandText(plan)}
      </Text>
      {plan.graph.nodes.map((n) => {
        const est = plan.estimate.nodes.find((e) => e.nodeId === n.id);
        const ref = n.model ?? est?.ref;
        return (
          <Text key={n.id} inverse={selected === n.id}>
            #{n.id} {n.title} · {n.protocol} · {ref ? refKey(ref) : t('thread.unroutable')}
          </Text>
        );
      })}
      {!plan.estimate.complete &&
        plan.estimate.problems.map((p, i) => (
          <Text key={i} color="red">
            ✕ {p}
          </Text>
        ))}
    </Box>
  );
}

function lastLine(n: NodeRun | undefined): string {
  const streams = Object.values(n?.streams ?? {});
  const text = streams.at(-1) ?? n?.contributions.at(-1)?.text ?? '';
  const line = text.trimEnd().split('\n').at(-1) ?? '';
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

/** The live thread: every node with its state, model, cost and last line of output. */
export function ThreadPane({ run, selected }: { run: RunView; selected?: string }) {
  const est = run.estimate;
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        {t('tui.thread')} · <Badge state={run.state} /> ·{' '}
        {est
          ? t('cost.spent', { cost: formatUsd(run.costUsd), cap: formatUsd(est.totalUsd) })
          : t('cost.soFar', { cost: formatUsd(run.costUsd) })}
      </Text>
      {(run.graph?.nodes ?? []).map((g) => {
        const n = run.nodes[g.id];
        return (
          <Box key={g.id} flexDirection="column">
            <Text inverse={selected === g.id}>
              #{g.id} <Badge state={n?.state ?? 'pending'} /> {g.title}
              {n?.ref ? ` · ${refKey(n.ref)}` : ''} · {formatUsd(n?.costUsd ?? 0)}
            </Text>
            {lastLine(n) ? <Text dimColor> {lastLine(n)}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

/** Spec §4.4 in the terminal: who works, on what, since when, for how much. */
export function AgentsPane({ run, now }: { run: RunView | undefined; now: number }) {
  const rows = Object.entries(run?.nodes ?? {}).filter(
    ([, n]) => (n.state === 'running' || n.state === 'review') && n.ref,
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{t('tui.agents')}</Text>
      {rows.length === 0 ? (
        <Text dimColor>{t('tui.noAgents')}</Text>
      ) : (
        rows.map(([id, n]) => (
          <Text key={id}>
            {refKey(n.ref!)} · #{id} {n.role ?? ''} ·{' '}
            {formatDuration(now - (n.stepStartedAt ?? n.startedAt ?? now))} · {formatUsd(n.costUsd)}
          </Text>
        ))
      )}
    </Box>
  );
}

export function ControlPane({ run }: { run: RunView }) {
  if (run.controls.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>{t('tui.steering')}</Text>
      {run.controls.slice(-5).map((c, i) => (
        <Text key={i}>• {controlText(c.event)}</Text>
      ))}
    </Box>
  );
}

const MAX_LINES = 12;

/** A confirmation: the question and any diff or content as text; the default is No. */
export function ConfirmPane({ c, now }: { c: ConfirmView; now: number }) {
  const body = c.patch ?? c.content ?? '';
  const lines = body ? body.split('\n') : [];
  const left = Math.max(0, c.receivedAt + c.timeoutMs - now);
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      <Text bold>{t('tui.confirm', { title: t(`confirm.title.${c.kind}`) })}</Text>
      {c.risk ? <Text>{t('confirm.risk', { risk: t(`confirm.risk.${c.risk}`) })}</Text> : null}
      <Text>{c.question}</Text>
      {lines.slice(0, MAX_LINES).map((l, i) => (
        <Text key={i} dimColor>
          {l}
        </Text>
      ))}
      {lines.length > MAX_LINES ? (
        <Text dimColor>{t('tui.confirmMore', { count: lines.length - MAX_LINES })}</Text>
      ) : null}
      <Text>{t('confirm.timeout', { time: formatDuration(left) })}</Text>
      <Text bold>{t('tui.confirmKeys')}</Text>
    </Box>
  );
}
