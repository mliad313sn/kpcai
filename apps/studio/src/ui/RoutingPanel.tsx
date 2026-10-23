import { t } from '../i18n/core';
import type { NodeEstimate } from '../rpc/schemas';
import { formatRange, formatScore } from '../store/format';
import { refKey } from '../store/reducer';
import type { NodeRun } from '../store/types';

function Parts({ parts }: { parts: Record<string, number | null> }) {
  const rows = Object.entries(parts).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) return null;
  return (
    <table className="steps small">
      <caption>{t('routing.breakdown')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('routing.part')}</th>
          <th scope="col">{t('routing.value')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, value]) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td className="num">
              {value === null ? t('routing.notMeasured') : formatScore(value)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Steps({ est }: { est: NodeEstimate }) {
  if (est.steps.length === 0) return null;
  return (
    <table className="steps small">
      <caption>{t('routing.steps')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('routing.role')}</th>
          <th scope="col">{t('routing.model')}</th>
          <th scope="col">{t('routing.calls')}</th>
          <th scope="col">{t('routing.estimate')}</th>
        </tr>
      </thead>
      <tbody>
        {est.steps.map((s, i) => (
          <tr key={i}>
            <th scope="row">{s.role}</th>
            <td className="mono">
              {refKey(s.ref)}
              {s.diversityWaived ? ` ${t('routing.sameProvider')}` : ''}
            </td>
            <td className="num">
              {s.calls.min === s.calls.max ? s.calls.max : `${s.calls.min}–${s.calls.max}`}
            </td>
            <td className="num">{formatRange(s.minUsd, s.expectedUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * R-303 "why this model": the router's one-line reason, its score and breakdown, and the
 * runner-up. Live events (the model actually working) win over the plan's estimate.
 */
export function RoutingPanel({ est, n }: { est: NodeEstimate | undefined; n?: NodeRun }) {
  const reason = n?.reason ?? est?.reason;
  const score = n?.score ?? est?.score;
  return (
    <section aria-labelledby="detail-routing" className="routing">
      <h4 id="detail-routing">{t('routing.title')}</h4>
      <p>{reason ?? <span className="muted">{t('routing.noReason')}</span>}</p>
      {est?.upgraded && <p>{t('routing.upgraded', { why: est.upgraded })}</p>}
      {est?.error && <p className="error-text">{t('routing.cannot', { error: est.error })}</p>}
      <dl className="kv small">
        <dt>{t('routing.score')}</dt>
        <dd>{formatScore(score)}</dd>
        <dt>{t('routing.runnerUp')}</dt>
        <dd>
          {est?.runnerUp ? (
            <>
              <span className="mono">{refKey(est.runnerUp.ref)}</span>{' '}
              {t('routing.runnerUpScore', { score: formatScore(est.runnerUp.score) })}
            </>
          ) : (
            <span className="muted">{t('routing.none')}</span>
          )}
        </dd>
        {n?.tokens && (
          <>
            <dt>{t('routing.tokens')}</dt>
            <dd>{t('routing.tokensValue', { input: n.tokens.input, output: n.tokens.output })}</dd>
          </>
        )}
      </dl>
      {est?.parts && <Parts parts={est.parts} />}
      {est && <Steps est={est} />}
    </section>
  );
}
