/**
 * The productivity block of `kpai stats --productivity` (R-406): what the journal shows of
 * this workspace's runs, in the user's language. Every figure comes from the kernel's
 * `learning.productivity()` (docs/metrics/PRODUCTIVITY.md); nothing is estimated here.
 */
import type { ProductivityView } from '@kernelpai/kernel';
import { formatMoney, type Money } from '../config.js';
import { t } from '../i18n/core.js';

const DAY_MS = 86_400_000;

const pct = (x: number | null): string => (x === null ? '–' : `${Math.round(x * 100)}%`);

/** 45s, 3m 20s, 2h 05m: wall time, as journaled. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function perChange(p: ProductivityView, m: Money): string {
  if (p.costPerAcceptedChangeUsd === null || p.timePerAcceptedChangeMs === null)
    return t('prod.perChangeNone');
  return t('prod.perChange', {
    cost: formatMoney(p.costPerAcceptedChangeUsd, m),
    time: duration(p.timePerAcceptedChangeMs),
  });
}

function review(p: ProductivityView, m: Money): string {
  const r = p.review;
  return t('prod.review', {
    usd: formatMoney(r.reviewUsd, m),
    findings: r.acceptedFindings,
    each: r.usdPerAcceptedFinding === null ? '–' : formatMoney(r.usdPerAcceptedFinding, m),
    issues: r.issuesRaised,
    nodes: r.nodes,
  });
}

/** The block printed after the estimate accuracy block. */
export function renderProductivity(p: ProductivityView, m: Money): string {
  const c = p.changes;
  const lines = [
    t('prod.header'),
    ...(p.since ? [t('prod.since', { since: p.since })] : []),
    t('prod.runs', {
      runs: p.runs,
      spent: formatMoney(p.spentUsd, m),
      time: duration(p.runTimeMs),
    }),
    t('prod.changes', { ...c }),
    perChange(p, m),
    t('prod.rework', {
      rolledBack: p.rolledBack,
      rollbackRate: pct(p.rollbackRate),
      reworked: p.reworked,
      reworkRate: pct(p.reworkRate),
      days: Math.round((p.reworkWindowMs / DAY_MS) * 10) / 10,
      unattributed: p.unattributedRestores,
    }),
    review(p, m),
    t('prod.band', { inBand: p.band.inBand, runs: p.band.runs, rate: pct(p.band.rate) }),
  ];
  return `${lines.join('\n')}\n`;
}
