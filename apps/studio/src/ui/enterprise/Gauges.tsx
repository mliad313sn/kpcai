/**
 * Gauges (design §14.3): spend against the envelope with the band tops of live runs
 * reserved (D-021), spend rate against its cap (S10 R3), heartbeat age (R2), subscription
 * quota and local compute (R-5E7), and the assurance mix V0–V3 (R5). Every figure is
 * written in words; bars only illustrate it.
 */
import { t } from '../../i18n/core';
import {
  assuranceShares,
  portfolioSpend,
  quotaGauges,
  rateOver,
  type SpendGauge,
} from '../../enterprise/derive';
import type { Gauge } from '../../enterprise/schemas';
import { useEnt } from '../../enterprise/store';
import { formatPct, formatUsd } from '../../store/format';
import { formatHours } from '../../enterprise/words';
import { HeartbeatCard } from './Heartbeat';
import { ASSURANCE } from './parts';

const pct = (x: number): string => `${Math.max(0, Math.min(100, x * 100)).toFixed(2)}%`;

function SpendBar({ g }: { g: SpendGauge }) {
  const scale = Math.max(g.cap, g.committed) || 1;
  return (
    <div className="meter" aria-hidden="true">
      <span className="meter-spent" style={{ width: pct(g.spent / scale) }} />
      <span className="meter-reserved" style={{ width: pct(g.reserved / scale) }} />
      {g.over ? <span className="meter-cap" style={{ left: pct(g.cap / scale) }} /> : null}
    </div>
  );
}

function SpendCard({ g }: { g: SpendGauge | undefined }) {
  return (
    <article className="gauge-card" aria-labelledby="g-spend">
      <h4 id="g-spend">{t('ent.gauge.spend')}</h4>
      {g ? (
        <>
          <p className="gauge-big">{t('ent.gauge.spent', { usd: formatUsd(g.spent) })}</p>
          <SpendBar g={g} />
          <p className="small">
            {t('ent.gauge.committed', {
              committed: formatUsd(g.committed),
              reserved: formatUsd(g.reserved),
              cap: formatUsd(g.cap),
              share: formatPct(g.cap > 0 ? g.committed / g.cap : null),
            })}
          </p>
          {g.over ? <p className="small tone-danger">{t('ent.gauge.over')}</p> : null}
        </>
      ) : (
        <p className="muted small">{t('ent.gauge.noSpend')}</p>
      )}
    </article>
  );
}

function RateCard({ g }: { g: SpendGauge | undefined }) {
  const rate = g?.rate;
  const over = g ? rateOver(g) : false;
  return (
    <article className="gauge-card" aria-labelledby="g-rate">
      <h4 id="g-rate">{t('ent.gauge.rate')}</h4>
      <p className={`gauge-big ${over ? 'tone-danger' : ''}`}>
        {rate ? t('ent.gauge.perHour', { usd: formatUsd(rate.usdPerHour) }) : '—'}
      </p>
      <p className="small muted">
        {rate?.capUsdPerHour !== undefined
          ? t('ent.gauge.rateCap', { usd: formatUsd(rate.capUsdPerHour) })
          : t('ent.gauge.noRateCap')}
      </p>
      {over ? <p className="small tone-danger">{t('ent.gauge.rateOver')}</p> : null}
      {g?.concurrency ? (
        <p className="small">
          {t('ent.gauge.workers', { used: g.concurrency.inUse, limit: g.concurrency.limit })}
        </p>
      ) : null}
      <QueueLine />
    </article>
  );
}

/** Jobs waiting, and why the first held one does not start (limits, cap, kill switch). */
function QueueLine() {
  const queue = useEnt((s) => s.data.queue);
  const pending = queue.filter((j) => j.state === 'pending');
  if (pending.length === 0) return null;
  const held = pending.find((j) => j.held);
  return (
    <p className="small muted">
      {t('ent.gauge.queue', { count: pending.length })}
      {held?.held ? (
        <>
          {' '}
          <q className="q">{held.held}</q>
        </>
      ) : null}
    </p>
  );
}

function quotaLine(g: Gauge): string {
  const parts: string[] = [];
  const q = g.quota;
  if (q) {
    parts.push(
      q.runsCap !== undefined
        ? t('ent.quota.runsOf', { used: q.runs, cap: q.runsCap })
        : t('ent.quota.runs', { count: q.runs }),
    );
    parts.push(
      q.hoursCap !== undefined
        ? t('ent.quota.hoursOf', { used: formatHours(q.hours), cap: formatHours(q.hoursCap) })
        : formatHours(q.hours),
    );
  }
  if (g.localHours !== undefined)
    parts.push(t('ent.quota.local', { hours: formatHours(g.localHours) }));
  return parts.join(' · ');
}

function QuotaCard({ gauges }: { gauges: Gauge[] }) {
  return (
    <article className="gauge-card" aria-labelledby="g-quota">
      <h4 id="g-quota">{t('ent.gauge.quota')}</h4>
      {gauges.length === 0 ? (
        <p className="muted small">{t('ent.quota.none')}</p>
      ) : (
        <ul className="plain small">
          {gauges.map((g) => (
            <li key={g.id}>
              <span className="mono">{g.id}</span>: {quotaLine(g)}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function AssuranceCard() {
  const shares = assuranceShares(useEnt((s) => s.data.results));
  const stamp = useEnt((s) => s.data.rubberStamp);
  return (
    <article className="gauge-card" aria-labelledby="g-assurance">
      <h4 id="g-assurance">{t('ent.gauge.assurance')}</h4>
      {shares ? (
        <>
          <div className="meter meter-stack" aria-hidden="true">
            {shares.map((s) => (
              <span key={s.label} className={`seg-${s.label}`} style={{ width: pct(s.share) }} />
            ))}
          </div>
          <ul className="plain small legend">
            {shares.map((s) => (
              <li key={s.label}>
                <span className={`swatch seg-${s.label}`} aria-hidden="true" />
                <strong>{s.label}</strong> {t(ASSURANCE[s.label])}
                <span className="num">
                  {t('ent.assurance.count', { count: s.count, share: formatPct(s.share) })}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted small">{t('ent.assurance.none')}</p>
      )}
      {stamp && stamp.rate !== null && stamp.consequential > 0 ? (
        <p className="small">
          {t('ent.gauge.rubberStamp', {
            share: formatPct(stamp.rate),
            count: stamp.consequential,
          })}
        </p>
      ) : null}
    </article>
  );
}

export function Gauges() {
  const gauges = useEnt((s) => s.data.gauges);
  const spend = portfolioSpend(gauges);
  return (
    <section className="gauges" aria-labelledby="ent-gauges-h">
      <h3 id="ent-gauges-h" className="sr-only">
        {t('ent.gauges')}
      </h3>
      <SpendCard g={spend} />
      <RateCard g={spend} />
      <HeartbeatCard />
      <QuotaCard gauges={quotaGauges(gauges)} />
      <AssuranceCard />
    </section>
  );
}
