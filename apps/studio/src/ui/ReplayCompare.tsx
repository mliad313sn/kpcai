/**
 * R-403 side by side: the original attempt (kept as recorded) and its replay — models,
 * protocol, outcome, verdicts, cost and duration, then both outputs. Outputs are model
 * text: rendered as text only.
 */
import { t, type Key } from '../i18n/core';
import type { Attempt, ReplayView } from '../rpc/learning-schemas';
import { formatDuration, formatUsd } from '../store/format';
import { nodeKey } from '../store/learning';
import { refKey } from '../store/reducer';
import { useStudio } from '../store/store';

function signedUsd(x: number): string {
  return x > 0 ? `+${formatUsd(x)}` : x < 0 ? `−${formatUsd(-x)}` : formatUsd(0);
}

function durationText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : formatDuration(ms);
}

function signedMs(x: number): string {
  const text = durationText(Math.abs(x));
  return x > 0 ? `+${text}` : x < 0 ? `−${text}` : text;
}

function outcome(a: Attempt): string {
  if (!a.ok) return t('replay.failed', { error: a.error ?? '—' });
  if (a.approved === true) return t('replay.approved');
  if (a.approved === false) return t('replay.notApproved');
  return t('replay.ok');
}

function verdicts(a: Attempt): string {
  if (a.verdicts.length === 0) return t('replay.noVerdict');
  return a.verdicts
    .map((v) =>
      t(v.approve ? 'replay.verdictYes' : 'replay.verdictNo', {
        model: refKey(v.ref),
        count: v.issues,
      }),
    )
    .join(' · ');
}

const ROWS: Array<[Key, (a: Attempt) => string]> = [
  ['replay.models', (a) => a.models.map(refKey).join(', ') || '—'],
  ['replay.protocol', (a) => a.protocol],
  ['replay.outcome', outcome],
  ['replay.verdicts', verdicts],
  ['replay.cost', (a) => formatUsd(a.costUsd)],
  ['replay.duration', (a) => durationText(a.durationMs)],
];

function CompareTable({ r }: { r: ReplayView }) {
  return (
    <table className="steps small">
      <caption className="sr-only">{t('replay.compareTitle')}</caption>
      <thead>
        <tr>
          <td />
          <th scope="col">{t('replay.original')}</th>
          <th scope="col">{t('replay.replay')}</th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map(([key, f]) => (
          <tr key={key}>
            <th scope="row">{t(key)}</th>
            <td>{f(r.original)}</td>
            <td>{f(r.replay)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReplayCompare({ runId, nodeId }: { runId: string; nodeId: string }) {
  const entry = useStudio((s) => s.replays[nodeKey(runId, nodeId)]);
  if (!entry) return null;
  if (entry.pending)
    return (
      <p className="muted" role="status">
        {t('replay.running', { id: nodeId })}
      </p>
    );
  const r = entry.result;
  const c = r.comparison;
  return (
    <section aria-labelledby="replay-compare" className="replay-compare">
      <h4 id="replay-compare">{t('replay.compareTitle')}</h4>
      <p>
        {t(c.sameOutput ? 'replay.same' : 'replay.different')} ·{' '}
        {t('replay.costDelta', { delta: signedUsd(c.costDeltaUsd) })} ·{' '}
        {t('replay.durationDelta', { delta: signedMs(c.durationDeltaMs) })}
      </p>
      <CompareTable r={r} />
      <div className="side-by-side">
        <div>
          <h5>{t('replay.originalOutput')}</h5>
          <pre className="output" tabIndex={0} aria-label={t('replay.originalOutput')}>
            {r.original.output}
          </pre>
        </div>
        <div>
          <h5>{t('replay.replayOutput')}</h5>
          <pre className="output" tabIndex={0} aria-label={t('replay.replayOutput')}>
            {r.replay.output}
          </pre>
        </div>
      </div>
    </section>
  );
}
