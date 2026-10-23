/**
 * Phase 4 in the terminal: a disputed node's options (R-405), a model's proposed memory
 * fact (ADR-0027), the plan's memory and estimate accuracy, and the run's verification
 * ROI. Model text is shown as plain text, each quoted line prefixed with "│ ". A dispute
 * option is quoted a few lines; once picked it is shown in full, a window at a time, and
 * only an option read to the end and not cut by the kernel can be chosen (P4-F11).
 */
import { Box, Text } from 'ink';
import { t } from '../../studio/src/i18n/core';
import { memoryLines, verificationText } from '../../studio/src/store/summaries';
import type { ConfirmView, PlanView, RunView } from '../../studio/src/store/types';
import { MAX_QUOTE, WINDOW, quoteLines } from './dispute';

/**
 * Model text must never drive the terminal: ESC shows as ␛ and other control characters
 * (C0 except tab, DEL, C1) are dropped, so no escape sequence reaches the screen.
 */
export function inert(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b/g, '␛').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** Untrusted text as a quote: at most a few lines, the rest counted. */
export function Quote({ text }: { text: string }) {
  const lines = text.split('\n').map(inert);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {lines.slice(0, MAX_QUOTE).map((l, i) => (
        <Text key={i} dimColor>
          │ {l}
        </Text>
      ))}
      {lines.length > MAX_QUOTE ? (
        <Text dimColor>{t('tui.confirmMore', { count: lines.length - MAX_QUOTE })}</Text>
      ) : null}
    </Box>
  );
}

/** The picked option in full, one window at a time, with where the window is (P4-F11). */
function Scrolled({ text, top, n }: { text: string; top: number; n: number }) {
  const lines = quoteLines(text);
  const shown = lines.slice(top, top + WINDOW);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {shown.map((l, i) => (
        <Text key={top + i}>│ {inert(l)}</Text>
      ))}
      {lines.length > WINDOW ? (
        <Text bold>
          {t('tui.disputeWindow', {
            n,
            from: top + 1,
            to: top + shown.length,
            total: lines.length,
          })}
        </Text>
      ) : null}
    </Box>
  );
}

type Option = NonNullable<ConfirmView['dispute']>['options'][number];

/** One option: its label and backers, then its text (in full when picked). */
function OptionView(props: { o: Option; i: number; picked: boolean; scroll: number }) {
  const { o, i, picked, scroll } = props;
  const cut = o.truncated === true;
  return (
    <Box flexDirection="column">
      <Text bold={picked} inverse={picked}>
        {picked ? '◉' : '○'} {i + 1}. {inert(o.label)}
        {o.backers.length
          ? ` ${t('dispute.backers', { models: inert(o.backers.join(', ')) })}`
          : ''}
      </Text>
      {cut ? <Text color="yellow">⚠ {t('dispute.truncated')}</Text> : null}
      {picked && !cut ? <Scrolled text={o.text} top={scroll} n={i + 1} /> : <Quote text={o.text} />}
    </Box>
  );
}

/** The options of a dispute, numbered; the picked one is marked and shown in full. */
export function DisputeBody({
  c,
  choice,
  scroll = 0,
}: {
  c: ConfirmView;
  choice?: number;
  scroll?: number;
}) {
  const d = c.dispute!;
  return (
    <Box flexDirection="column">
      <Text>{t('dispute.title', { id: d.nodeId })}</Text>
      <Text>{inert(t('dispute.reason', { kind: d.kind, reason: d.reason }))}</Text>
      <Text color="yellow">⚠ {t('dispute.untrusted')}</Text>
      {d.positions.map((p, i) => (
        <Box key={`p${i}`} flexDirection="column">
          <Text>
            {inert(p.ref)} · {inert(p.role)}
          </Text>
          <Quote text={p.says} />
        </Box>
      ))}
      {d.options.map((o, i) => (
        <OptionView key={o.id} o={o} i={i} picked={choice === i} scroll={scroll} />
      ))}
      <Text bold>{t('tui.disputeKeys', { count: d.options.length })}</Text>
    </Box>
  );
}

/** A model's proposed fact: quoted, with its source and evidence. */
export function MemoryBody({ c }: { c: ConfirmView }) {
  const m = c.memory!;
  return (
    <Box flexDirection="column">
      <Text>{t('memory.proposedFor', { layer: t(`memory.layer.${m.layer}`) })}</Text>
      <Quote text={m.text} />
      <Text>
        {t('tui.memoryFrom', {
          source: inert(m.source),
          trust: t(m.source === 'human' ? 'memory.trusted' : 'memory.untrusted'),
        })}
        {m.evidence.length
          ? ` · ${t('memory.evidenceList', { evidence: m.evidence.join(', ') })}`
          : ''}
        {m.localOnly ? ` · ${t('memory.localOnlyTag')}` : ''}
      </Text>
      <Text bold>{t('tui.memoryKeys')}</Text>
    </Box>
  );
}

/** The plan's memory and the published estimate accuracy (R-402). */
export function PlanExtras({ plan }: { plan: PlanView }) {
  const lines = plan.memory ? memoryLines(plan.memory) : [];
  const accuracy = plan.estimate.accuracy;
  return (
    <>
      {plan.fork ? (
        <Text>
          {t('fork.title', {
            run: plan.fork.parent.runId.slice(0, 8),
            id: plan.fork.parent.nodeId,
          })}
        </Text>
      ) : null}
      {accuracy ? <Text dimColor>{t('plan.accuracy', { note: accuracy })}</Text> : null}
      {lines.map((l, i) => (
        <Text
          key={i}
          {...(l.tone === 'warn' ? { color: 'yellow' } : {})}
          dimColor={l.tone === 'muted'}
        >
          {l.tone === 'warn' ? '⚠ ' : ''}
          {l.text}
        </Text>
      ))}
    </>
  );
}

export function VerificationText({ run }: { run: RunView }) {
  if (!run.verification) return null;
  return (
    <Text dimColor>
      {t('verify.title')} {verificationText(run.verification)}
    </Text>
  );
}
