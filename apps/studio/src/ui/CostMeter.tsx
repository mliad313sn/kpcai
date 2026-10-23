import { t, type Key } from '../i18n/core';
import type { Band, GraphEstimate } from '../rpc/schemas';
import { formatRange, formatUsd } from '../store/format';

const BASIS: Record<Band['basis'], Key> = {
  calibrated: 'cost.basis.calibrated',
  heuristic: 'cost.basis.heuristic',
  mixed: 'cost.basis.mixed',
};

/** The low–high band of an estimate; older kernels without a band give min–expected. */
export function bandOf(est: GraphEstimate): Band {
  return est.band ?? { lowUsd: est.minUsd, highUsd: est.totalUsd, basis: 'heuristic' };
}

/**
 * R-302 before launch: the band and the hard cap. The cap is the accepted total
 * (`maxGraphUsd`, ADR-0019): the run stops rather than spend more.
 */
export function CostBand({ est }: { est: GraphEstimate }) {
  const band = bandOf(est);
  return (
    <span className="cost-band">
      {t('cost.band', {
        range: formatRange(band.lowUsd, band.highUsd),
        basis: t(BASIS[band.basis]),
        cap: formatUsd(est.totalUsd),
      })}
    </span>
  );
}

/**
 * R-302 during the run: spend so far against the cap, with the band as the meter's
 * low/high marks. Updated on every contribution event (each model response).
 */
export function CostMeter({ spent, est }: { spent: number; est: GraphEstimate | undefined }) {
  if (!est) {
    return <span>{t('cost.soFar', { cost: formatUsd(spent) })}</span>;
  }
  const band = bandOf(est);
  const cap = Math.max(est.totalUsd, band.highUsd, spent, 1e-9);
  const pct = Math.round((spent / cap) * 100);
  const over = spent > band.highUsd;
  return (
    <span className="cost-meter">
      <label htmlFor="cost-meter">
        {t('cost.spent', { cost: formatUsd(spent), cap: formatUsd(est.totalUsd) })}
      </label>
      <meter
        id="cost-meter"
        min={0}
        max={cap}
        low={band.lowUsd}
        high={band.highUsd}
        optimum={0}
        value={spent}
        aria-valuetext={t('cost.valuetext', {
          cost: formatUsd(spent),
          pct,
          range: formatRange(band.lowUsd, band.highUsd),
        })}
      />
      <span className={`small ${over ? 'error-text' : 'muted'}`}>
        {over && <span aria-hidden="true">⚠ </span>}
        {t(over ? 'cost.above' : 'cost.bandOnly', {
          range: formatRange(band.lowUsd, band.highUsd),
        })}
      </span>
    </span>
  );
}
