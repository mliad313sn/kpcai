/**
 * The north-star block of `kpai stats --north-star` (S10): Durable Verified Outcomes per
 * week and the six guardrails, as the kernel's `learning.northStar()` computes them from
 * the journal (docs/metrics/NORTH-STAR.md). Nothing is estimated here; what the journal
 * cannot show is printed as "not measured".
 */
import type { NorthStarView } from '@kernelpai/kernel';
import { formatMoney, type Money } from '../config.js';
import { t } from '../i18n/core.js';
import { duration } from './productivity.js';

const pct = (x: number | null): string => (x === null ? '–' : `${Math.round(x * 100)}%`);
const num = (x: number | null): string => (x === null ? '–' : String(x));
const state = (ok: boolean): string => t(ok ? 'ns.ok' : 'ns.breach');

function head(n: NorthStarView): string[] {
  return [
    t('ns.header'),
    ...(n.since ? [t('ns.since', { since: n.since })] : []),
    t('ns.counts', { dvo: n.dvo, doc: n.dvoDoc, provisional: n.provisional, intents: n.intents }),
    t('ns.mix', {
      v1: n.mix.V1,
      v2: n.mix.V2,
      v3: n.mix.V3,
      share: pct(n.v3Share),
      durability: n.durability,
    }),
    ...n.weeks.map((w) =>
      t('ns.week', {
        week: w.week,
        dvo: w.dvo,
        doc: w.dvoDoc,
        state: t(w.final ? 'ns.final' : 'ns.provisional'),
      }),
    ),
  ];
}

function guardrails(n: NorthStarView, m: Money): string[] {
  const g = n.guardrails;
  const energy = g.g6Energy.perDvoWh
    ? `${g.g6Energy.perDvoWh[0]}–${g.g6Energy.perDvoWh[1]} Wh`
    : t('ns.notMeasured');
  return [
    t('ns.guardrails'),
    t('ns.g1', {
      cost: g.g1Cost.costPerDvoUsd === null ? '–' : formatMoney(g.g1Cost.costPerDvoUsd, m),
      band: pct(g.g1Cost.band.rate),
      cap: num(g.g1Cost.capToLikelyMedian),
    }),
    t('ns.g2', {
      asks: g.g2Attention.asks,
      perDvo: num(g.g2Attention.asksPerDvo),
      age: g.g2Attention.medianAskAgeMs === null ? '–' : duration(g.g2Attention.medianAskAgeMs),
      stamped: g.g2Attention.rubberStamp.stamped,
      consequential: g.g2Attention.rubberStamp.consequential,
      rate: pct(g.g2Attention.rubberStamp.rate),
    }),
    t('ns.g3', {
      silent: g.g3Silent.silent,
      started: g.g3Silent.started,
      rate: pct(g.g3Silent.rate),
      unfollowed: g.g3Silent.alerts.unfollowed ?? t('ns.notMeasured'),
      gaps: g.g3Silent.heartbeat.gaps,
    }),
    t('ns.g4', {
      escaped: g.g4Escape.escaped,
      accepted: g.g4Escape.accepted,
      rate: pct(g.g4Escape.rate),
      v1: pct(g.g4Escape.byAssurance.V1.rate),
      v2: pct(g.g4Escape.byAssurance.V2.rate),
    }),
    t('ns.g5', { total: g.g5Safety.total, state: state(g.g5Safety.ok) }),
    t('ns.g6', { energy }),
  ];
}

/** The block printed after the productivity block. */
export function renderNorthStar(n: NorthStarView, m: Money): string {
  const lines = [
    ...head(n),
    ...guardrails(n, m),
    n.breached.length ? t('ns.breached', { list: n.breached.join(', ') }) : t('ns.noBreach'),
    // Reasons stay as the library words them (English): they name journal fields.
    ...n.notMeasured.map((item) => t('ns.gap', { item })),
  ];
  return `${lines.join('\n')}\n`;
}
