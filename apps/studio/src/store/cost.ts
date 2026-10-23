/**
 * D-021 cost figures of an estimate: the likely cost and the hard cap. The cap is what the
 * user approves, what the budget gate checks and what the kernel enforces (`maxGraphUsd`):
 * the top of the band. Older kernels send neither figure; they are then derived.
 */
import { t, type Key } from '../i18n/core';
import type { Band, GraphEstimate } from '../rpc/schemas';
import { formatUsd } from './format';

const BASIS: Record<Band['basis'], Key> = {
  calibrated: 'cost.basis.calibrated',
  heuristic: 'cost.basis.heuristic',
  mixed: 'cost.basis.mixed',
};

export interface CostFigures {
  /** The likely cost: the sum of the nodes' expected costs. */
  expected: number;
  /** The most the run may spend: the band's top (D-021). */
  cap: number;
  /** Low–high spread, the live meter's low and high marks. */
  band: Band;
}

/** The low–high band of an estimate; older kernels without a band give min–total. */
export function bandOf(est: GraphEstimate): Band {
  return est.band ?? { lowUsd: est.minUsd, highUsd: est.totalUsd, basis: 'heuristic' };
}

export function costOf(est: GraphEstimate): CostFigures {
  const band = bandOf(est);
  const sum = est.nodes.reduce((acc, n) => acc + n.expectedUsd, 0);
  const expected = est.expectedUsd ?? (est.nodes.length > 0 ? sum : est.totalUsd);
  // Before D-021 `totalUsd` was the expected sum and the band's top sat above it: the
  // larger of the two is the worst plausible cost.
  const cap = est.capUsd ?? Math.max(band.highUsd, est.totalUsd);
  return { expected: Math.min(expected, cap), cap, band };
}

/** One line, web and terminal: "Estimate: likely $X · at most $Y (hard cap) · basis". */
export function costLine(est: GraphEstimate): string {
  const c = costOf(est);
  return t('cost.band', {
    expected: formatUsd(c.expected),
    cap: formatUsd(c.cap),
    basis: t(BASIS[c.band.basis]),
  });
}
