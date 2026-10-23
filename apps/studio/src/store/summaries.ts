/**
 * Plain-text summaries shared by the web console and the terminal: the memory a plan
 * sends (ADR-0027: counts and sources, never the text) and a run's verification ROI
 * (R-404). Each line is a whole translated sentence.
 */
import { t, type Key } from '../i18n/core';
import type { Verification } from '../rpc/learning-schemas';
import { formatPct, formatUsd } from './format';
import type { MemorySummary } from './types';

const ORIGIN: Record<string, Key> = {
  user: 'memory.layer.user',
  project: 'memory.layer.project',
  session: 'memory.layer.session',
  repository: 'memory.layer.repository',
};

export interface SummaryLine {
  text: string;
  tone: 'info' | 'muted' | 'warn';
}

function layersText(m: MemorySummary): string {
  return m.layers
    .filter((l) => l.included > 0)
    .map((l) =>
      t('plan.memoryLayer', {
        layer: t(ORIGIN[l.origin] ?? 'memory.layer.user'),
        count: l.included,
      }),
    )
    .join(', ');
}

/** The plan's memory: what is sent, what was left out or withheld, distrust, problems. */
export function memoryLines(m: MemorySummary): SummaryLine[] {
  const sent = m.included.length;
  const untrusted = m.included.filter((f) => f.trust === 'untrusted').length;
  const head =
    sent === 0
      ? t('plan.memoryNone')
      : `${t('plan.memory', { count: sent, layers: layersText(m), untrusted })} ${t(
          'plan.memoryTokens',
          { used: m.usedTokens, budget: m.budgetTokens },
        )}`;
  const lines: SummaryLine[] = [{ text: head, tone: 'info' }];
  if (m.truncated)
    lines.push({
      text: t('plan.memoryTruncated', { count: m.omitted, budget: m.budgetTokens }),
      tone: 'warn',
    });
  if (m.localOnly > 0)
    lines.push({ text: t('plan.memoryLocalOnly', { count: m.localOnly }), tone: 'muted' });
  // P4-F3: the routing restriction local-only facts put on the run (kernel text, as sent).
  const rule = (m as { localOnlyRule?: unknown }).localOnlyRule;
  if (typeof rule === 'string' && rule.trim())
    lines.push({ text: t('plan.memoryLocalOnlyRule', { rule: rule.trim() }), tone: 'muted' });
  if (m.distrusted) lines.push({ text: t('plan.memoryDistrusted'), tone: 'warn' });
  for (const p of m.problems)
    lines.push({ text: t('plan.memoryProblem', { problem: p }), tone: 'warn' });
  if (m.pending > 0)
    lines.push({ text: t('plan.memoryPending', { count: m.pending }), tone: 'info' });
  return lines;
}

/**
 * R-404 in one line: review spend and its share, then the headline — revised verdicts and
 * their price (P4-F12) — then the raw issues raised.
 */
export function verificationText(v: Verification): string {
  const spend = t('verify.spend', {
    review: formatUsd(v.reviewUsd),
    share: formatPct(v.share),
    total: formatUsd(v.totalUsd),
  });
  if (v.revisedVerdicts === undefined)
    return [spend, t('verify.issues', { count: v.issuesRaised })].join(' · ');
  return [
    spend,
    t('verify.revised', { count: v.revisedVerdicts }),
    v.usdPerRevisedVerdict === null
      ? t('verify.noRevised')
      : t('verify.perRevised', { cost: formatUsd(v.usdPerRevisedVerdict) }),
    t('verify.rawIssues', { count: v.issuesRaised }),
  ].join(' · ');
}
