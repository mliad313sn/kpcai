/**
 * R-406 productivity, computed by the kernel from the journal only (docs/metrics/
 * PRODUCTIVITY.md): what was spent, the changes accepted, their cost and time, and how
 * many were rolled back or reworked later. Figures are shown as the kernel gives them.
 */
import { t, type Key } from '../i18n/core';
import type { ProductivityView } from '../rpc/learning-schemas';
import { formatDuration, formatPct, formatUsd } from '../store/format';

const usd = (x: number | null) => (x === null ? '—' : formatUsd(x));
const ms = (x: number | null) => (x === null ? '—' : formatDuration(x));

/** Label and value of each line; review and band only when the kernel sends them. */
function rows(p: ProductivityView): Array<[Key, string]> {
  const c = p.changes;
  const out: Array<[Key, string]> = [
    [
      'productivity.runs',
      t('productivity.runsValue', {
        runs: p.runs,
        spent: formatUsd(p.spentUsd),
        time: formatDuration(p.runTimeMs),
      }),
    ],
    [
      'productivity.changes',
      t('productivity.changesValue', {
        accepted: c.accepted,
        declined: c.declined,
        failed: c.failed,
        pending: c.pending,
        discarded: c.discarded,
      }),
    ],
    [
      'productivity.perChange',
      t('productivity.perChangeValue', {
        cost: usd(p.costPerAcceptedChangeUsd),
        time: ms(p.timePerAcceptedChangeMs),
      }),
    ],
    ['productivity.rollback', formatPct(p.rollbackRate)],
    [
      'productivity.rework',
      t('productivity.reworkValue', {
        rate: formatPct(p.reworkRate),
        days: Math.round(p.reworkWindowMs / 86_400_000),
      }),
    ],
  ];
  return [...out, ...extras(p)];
}

/** Review spend and band, only when the kernel sends them. */
function extras(p: ProductivityView): Array<[Key, string]> {
  const out: Array<[Key, string]> = [];
  if (p.review)
    out.push([
      'productivity.review',
      t('productivity.reviewValue', {
        review: formatUsd(p.review.reviewUsd),
        count: p.review.revisedVerdicts ?? '—',
        per: usd(p.review.usdPerRevisedVerdict),
        issues: p.review.issuesRaised ?? '—',
      }),
    ]);
  if (p.band)
    out.push([
      'productivity.band',
      t('accuracy.inBandValue', {
        n: p.band.inBand,
        of: p.band.runs,
        rate: formatPct(p.band.rate),
      }),
    ]);
  return out;
}

export function ProductivitySection({ p }: { p: ProductivityView }) {
  return (
    <section aria-labelledby="productivity-title">
      <h3 id="productivity-title">{t('productivity.title')}</h3>
      <p className="muted small">{t('productivity.help')}</p>
      <dl className="kv">
        {rows(p).map(([label, value]) => (
          <div key={label}>
            <dt>{t(label)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
