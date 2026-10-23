/**
 * The panes of KP Studio in the terminal, over the same store as the web console. Model
 * output is shown as plain text (Ink renders strings, never markup); states always carry a
 * word and an icon, colour only reinforces them.
 */
import { Box, Text } from 'ink';
import { t, type Key } from '../../studio/src/i18n/core';
import { controlText } from '../../studio/src/store/controls';
import { costLine, costOf } from '../../studio/src/store/cost';
import { formatDuration, formatRange, formatUsd } from '../../studio/src/store/format';
import { refKey } from '../../studio/src/store/reducer';
import { isDisputed } from '../../studio/src/store/disputes';
import type { ConfirmView, NodeRun, PlanView, RunView } from '../../studio/src/store/types';
import { DisputeBody, MemoryBody, PlanExtras, VerificationText, inert } from './learn';

const STATE: Record<string, { icon: string; key: Key; color?: string }> = {
  planned: { icon: '◇', key: 'state.planned' },
  pending: { icon: '○', key: 'state.waiting' },
  starting: { icon: '◌', key: 'state.starting' },
  running: { icon: '▶', key: 'state.running', color: 'cyan' },
  review: { icon: '◑', key: 'state.in_review', color: 'cyan' },
  disputed: { icon: '⚖', key: 'state.disputed', color: 'yellow' },
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

/** R-301/R-302 in the terminal: nodes, who would do them, the likely cost and the cap. */
export function PlanPane({ plan, selected }: { plan: PlanView; selected?: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        {t('tui.plan')} · {costLine(plan.estimate)}
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
      <PlanExtras plan={plan} />
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
  const line = inert(text.trimEnd().split('\n').at(-1) ?? '');
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

/** Spend against the cap (D-021), flagged in words when it goes above the band. */
function SpendText({ run }: { run: RunView }) {
  const est = run.estimate;
  if (!est) return <Text>{t('cost.soFar', { cost: formatUsd(run.costUsd) })}</Text>;
  const { cap, band } = costOf(est);
  const over = run.costUsd > band.highUsd;
  const range = formatRange(band.lowUsd, band.highUsd);
  return (
    <Text>
      {t('cost.spent', { cost: formatUsd(run.costUsd), cap: formatUsd(cap) })} ·{' '}
      {over ? (
        <Text color="red">⚠ {t('cost.above', { range })}</Text>
      ) : (
        t('cost.bandOnly', { range })
      )}
    </Text>
  );
}

/** The live thread: every node with its state, model, cost and last line of output. */
export function ThreadPane({ run, selected }: { run: RunView; selected?: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        {t('tui.thread')} · <Badge state={run.state} /> · <SpendText run={run} />
      </Text>
      <VerificationText run={run} />
      {(run.graph?.nodes ?? []).map((g) => {
        const n = run.nodes[g.id];
        return (
          <Box key={g.id} flexDirection="column">
            <Text inverse={selected === g.id}>
              #{g.id} <Badge state={isDisputed(run, g.id) ? 'disputed' : (n?.state ?? 'pending')} />{' '}
              {g.title}
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
const MAX_DIFF_LINES = 40;

function diffColor(line: string): string | undefined {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return 'cyan';
  if (line.startsWith('+')) return 'green';
  if (line.startsWith('-')) return 'red';
  return undefined;
}

/** A patch as text: lines keep their own +/- markers, colour only reinforces them. */
function PatchLines({ patch }: { patch: string }) {
  const lines = patch.split('\n');
  return (
    <>
      {lines.slice(0, MAX_DIFF_LINES).map((l, i) => {
        const color = diffColor(l);
        return (
          <Text key={i} {...(color ? { color } : {})}>
            {inert(l) || ' '}
          </Text>
        );
      })}
      {lines.length > MAX_DIFF_LINES ? (
        <Text dimColor>{t('tui.confirmMore', { count: lines.length - MAX_DIFF_LINES })}</Text>
      ) : null}
    </>
  );
}

/** The Diff tab in the terminal (Ctrl+O): each patch, its files and whether it is applied. */
export function DiffPane({ run }: { run: RunView | undefined }) {
  const patches = run?.patches ?? [];
  const pending = patches.filter((p) => !run!.applied.includes(p.nodeId)).length;
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        {t('tui.diff')} · {t('diff.summary', { count: patches.length })}
      </Text>
      {patches.length === 0 ? <Text dimColor>{t('tui.noPatches')}</Text> : null}
      {patches.map((p) => (
        <Box key={p.nodeId} flexDirection="column" marginTop={1}>
          <Text bold>
            #{p.nodeId} · {t('diff.files', { count: p.files.length })} ·{' '}
            {run!.applied.includes(p.nodeId) ? t('diff.applied') : t('tui.notApplied')}
          </Text>
          {p.files.length > 0 ? <Text dimColor>{p.files.join(', ')}</Text> : null}
          <PatchLines patch={p.patch} />
        </Box>
      ))}
      <Text>{pending > 0 ? t('tui.applyHint', { count: pending }) : t('tui.diffClose')}</Text>
    </Box>
  );
}

/** A confirmation: the question and any diff or content as text; the default is No. */
export function ConfirmPane({ c, now, choice }: { c: ConfirmView; now: number; choice?: number }) {
  const body = c.patch ?? c.content ?? '';
  const lines = body ? body.split('\n') : [];
  const left = Math.max(0, c.receivedAt + c.timeoutMs - now);
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      <Text bold>{t('tui.confirm', { title: t(`confirm.title.${c.kind}`) })}</Text>
      {c.risk ? <Text>{t('confirm.risk', { risk: t(`confirm.risk.${c.risk}`) })}</Text> : null}
      <Text>{inert(c.question)}</Text>
      {lines.slice(0, MAX_LINES).map((l, i) => (
        <Text key={i} dimColor>
          {inert(l)}
        </Text>
      ))}
      {lines.length > MAX_LINES ? (
        <Text dimColor>{t('tui.confirmMore', { count: lines.length - MAX_LINES })}</Text>
      ) : null}
      {c.dispute ? <DisputeBody c={c} {...(choice !== undefined ? { choice } : {})} /> : null}
      {c.memory ? <MemoryBody c={c} /> : null}
      <Text>
        {t(c.dispute ? 'dispute.timeout' : c.memory ? 'memory.timeout' : 'confirm.timeout', {
          time: formatDuration(left),
        })}
      </Text>
      {c.dispute || c.memory ? null : <Text bold>{t('tui.confirmKeys')}</Text>}
    </Box>
  );
}
