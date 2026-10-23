/**
 * Phase 4 in the terminal: a disputed node's options (R-405), a model's proposed memory
 * fact (ADR-0027), the plan's memory and estimate accuracy, and the run's verification
 * ROI. Model text is shown as plain text, each quoted line prefixed with "│ ".
 */
import { Box, Text } from 'ink';
import { t } from '../../studio/src/i18n/core';
import { memoryLines, verificationText } from '../../studio/src/store/summaries';
import type { ConfirmView, PlanView, RunView } from '../../studio/src/store/types';

const MAX_QUOTE = 6;

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

/** The options of a dispute, numbered; the picked one is marked. Default: reject. */
export function DisputeBody({ c, choice }: { c: ConfirmView; choice?: number }) {
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
        <Box key={o.id} flexDirection="column">
          <Text bold={choice === i} inverse={choice === i}>
            {choice === i ? '◉' : '○'} {i + 1}. {inert(o.label)}
            {o.backers.length
              ? ` ${t('dispute.backers', { models: inert(o.backers.join(', ')) })}`
              : ''}
          </Text>
          <Quote text={o.text} />
        </Box>
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
