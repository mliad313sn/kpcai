import { t } from '../i18n/core';
import type { Band, GraphEstimate } from '../rpc/schemas';
import { costLine, costOf } from '../store/cost';
import { formatRange, formatUsd } from '../store/format';

/**
 * R-302 and D-021 before launch: the likely cost and the hard cap, which is the band's top
 * (`maxGraphUsd`, ADR-0019): the run stops rather than spend more.
 */
export function CostBand({ est }: { est: GraphEstimate }) {
  const c = costOf(est);
  return (
    <span className="cost-band" title={t('cost.bandOnly', { range: rangeOf(c.band) })}>
      {costLine(est)}
    </span>
  );
}

function rangeOf(band: Band): string {
  return formatRange(band.lowUsd, band.highUsd);
}

/**
 * R-302 during the run: spend so far against the cap (the meter's maximum), with the band
 * as its low/high marks. Updated on every contribution event (each model response).
 */
export function CostMeter({ spent, est }: { spent: number; est: GraphEstimate | undefined }) {
  if (!est) {
    return <span>{t('cost.soFar', { cost: formatUsd(spent) })}</span>;
  }
  const { expected, cap, band } = costOf(est);
  const max = Math.max(cap, spent, 1e-9);
  const pct = Math.round((spent / Math.max(cap, 1e-9)) * 100);
  const over = spent > band.highUsd;
  return (
    <span className="cost-meter">
      <label htmlFor="cost-meter">
        {t('cost.spent', { cost: formatUsd(spent), cap: formatUsd(cap) })}
      </label>
      <meter
        id="cost-meter"
        min={0}
        max={max}
        low={band.lowUsd}
        high={band.highUsd}
        optimum={0}
        value={spent}
        aria-valuetext={t('cost.valuetext', {
          cost: formatUsd(spent),
          pct,
          expected: formatUsd(expected),
          range: rangeOf(band),
        })}
      />
      <span className={`small ${over ? 'error-text' : 'muted'}`}>
        {over && <span aria-hidden="true">⚠ </span>}
        {t(over ? 'cost.above' : 'cost.bandOnly', { range: rangeOf(band) })}
      </span>
    </span>
  );
}
