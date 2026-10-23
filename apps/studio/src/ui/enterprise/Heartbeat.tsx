/**
 * Liveness (S10 R2): the daemon's heartbeat age, shown everywhere the Sponsor looks. Only a
 * fresh heartbeat on a live connection reads as healthy; a late, stale, missing or
 * unreachable one is said in words, and a stale one is announced as an alert.
 */
import { t, type Key } from '../../i18n/core';
import { heartbeatStatus, type HeartbeatStatus, type Liveness } from '../../enterprise/derive';
import { useEnt } from '../../enterprise/store';
import { useStudio } from '../../store/store';
import { useNow } from '../hooks';
import { formatAge, livenessText } from '../../enterprise/words';

export function useLiveness(): HeartbeatStatus & { everySec?: number } {
  const hb = useEnt((s) => s.data.heartbeat);
  const connected = useStudio((s) => s.conn === 'open');
  const now = useNow(1000);
  return { ...heartbeatStatus(hb, now, connected), ...(hb ? { everySec: hb.intervalSec } : {}) };
}

const LOOK: Record<Liveness, { icon: string; tone: string; key: Key }> = {
  ok: { icon: '●', tone: 'ok', key: 'ent.beat.ok' },
  late: { icon: '◐', tone: 'warn', key: 'ent.beat.late' },
  alert: { icon: '⚠\uFE0E', tone: 'warn', key: 'ent.beat.alert' },
  stale: { icon: '⚠︎', tone: 'danger', key: 'ent.beat.stale' },
  unknown: { icon: '?', tone: 'warn', key: 'ent.beat.unknown' },
  offline: { icon: '⚠︎', tone: 'danger', key: 'ent.beat.offline' },
};

export { livenessText };

/** Compact: in the Enterprise header. */
export function HeartbeatBadge() {
  const s = useLiveness();
  const look = LOOK[s.level];
  return (
    <span className={`beat badge tone-${look.tone} beat-${s.level}`}>
      <span aria-hidden="true" className="badge-icon">
        {look.icon}
      </span>
      {livenessText(s)}
    </span>
  );
}

const LOUD: Partial<Record<Liveness, Key>> = {
  stale: 'ent.beat.staleBanner',
  alert: 'ent.beat.alertBanner',
  offline: 'ent.beat.offlineBanner',
  unknown: 'ent.beat.unknownBanner',
};

/**
 * Loud when it matters. The alert region is always in the page so that its text, when it
 * appears, is announced by screen readers.
 */
export function HeartbeatBanner() {
  const s = useLiveness();
  const key = LOUD[s.level];
  const age = s.ageMs === undefined ? '—' : formatAge(s.ageMs);
  return (
    <div role="alert" className={key ? `beat-banner beat-banner-${s.level}` : 'beat-banner-off'}>
      {key ? (
        <>
          <strong>
            <span aria-hidden="true">⚠&#xFE0E; </span>
            {t(`${key}Title` as Key)}
          </strong>{' '}
          {t(key, { age })}
          {s.alerts.length ? (
            <ul className="small">
              {s.alerts.map((a, i) => (
                <li key={i}>
                  {a.programId ? <span className="tag mono">{a.programId}</span> : null}{' '}
                  <q className="q">{a.text}</q>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The gauge card: age, period, and what silence means. */
export function HeartbeatCard() {
  const s = useLiveness();
  const look = LOOK[s.level];
  return (
    <article className={`gauge-card gauge-beat tone-border-${look.tone}`} aria-labelledby="g-beat">
      <h4 id="g-beat">{t('ent.gauge.heartbeat')}</h4>
      <p className={`gauge-big tone-${look.tone}`}>
        <span aria-hidden="true">{look.icon} </span>
        {s.ageMs === undefined ? t('ent.beat.never') : formatAge(s.ageMs)}
      </p>
      <p className="small muted">
        {s.everySec
          ? t('ent.beat.every', { age: formatAge(s.everySec * 1000) })
          : t('ent.beat.noPeriod')}
      </p>
      <p className="small">{livenessText(s)}</p>
    </article>
  );
}
