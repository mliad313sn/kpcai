/**
 * Evidence the user can trust (phase 4): estimate accuracy (R-402), measured competence
 * (ADR-0028) and the run's verification ROI (R-404). Kernel figures and evidence phrases
 * are shown as text, never interpreted.
 */
import { useEffect } from 'react';
import { t } from '../i18n/core';
import type { Verification } from '../rpc/learning-schemas';
import { formatPct, formatScore, formatUsd } from '../store/format';
import { loadEvidence } from '../store/learning';
import { refKey } from '../store/reducer';
import { verificationText } from '../store/summaries';
import { useStudio } from '../store/store';
import type { Accuracy, AccuracyRow, CompetenceEntry } from '../store/types';
import { ProductivitySection } from './Productivity';
import { activeRun } from './view';

/** R-404 in one line: review spend, its share, findings raised and accepted, their price. */
export function VerificationLine({ v }: { v: Verification }) {
  return (
    <p className="small verification">
      <strong>{t('verify.title')}</strong> {verificationText(v)}
    </p>
  );
}

function errorPct(x: number | null): string {
  return x === null ? '—' : formatPct(x / 100);
}

function Row({ r, label }: { r: AccuracyRow; label: string }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="num">{r.samples}</td>
      <td className="num">{formatUsd(r.meanEstimateUsd)}</td>
      <td className="num">{formatUsd(r.meanActualUsd)}</td>
      <td className="num">{errorPct(r.meanAbsErrorPct)}</td>
      <td className="num">{errorPct(r.meanSignedErrorPct)}</td>
      <td className="num">
        {t('accuracy.inBandValue', { n: r.inBand, of: r.samples, rate: formatPct(r.inBandRate) })}
      </td>
      <td className="num">{r.below}</td>
      <td className="num">{r.above}</td>
    </tr>
  );
}

function Group({ rows, title }: { rows: AccuracyRow[]; title: string }) {
  if (rows.length === 0) return null;
  return (
    <tbody>
      <tr>
        <th scope="rowgroup" colSpan={9} className="group">
          {title}
        </th>
      </tr>
      {rows.map((r) => (
        <Row key={r.label} r={r} label={r.label} />
      ))}
    </tbody>
  );
}

const COLUMNS = [
  'accuracy.group',
  'accuracy.samples',
  'accuracy.estimate',
  'accuracy.actual',
  'accuracy.error',
  'accuracy.bias',
  'accuracy.inBand',
  'accuracy.below',
  'accuracy.above',
] as const;

export function AccuracyTable({ a }: { a: Accuracy }) {
  const x = a.excluded;
  return (
    <section aria-labelledby="accuracy-title">
      <h3 id="accuracy-title">{t('accuracy.title')}</h3>
      <p className="muted small">{t('accuracy.help')}</p>
      <div className="table-scroll">
        <table className="evidence">
          <caption className="sr-only">{t('accuracy.title')}</caption>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c} scope="col">
                  {t(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <Row r={a.runs} label={t('accuracy.allRuns')} />
          </tbody>
          <Group rows={a.byTaskType} title={t('accuracy.byTaskType')} />
          <Group rows={a.byBasis} title={t('accuracy.byBasis')} />
        </table>
      </div>
      <p className="muted small">
        {t('accuracy.excluded', {
          cancelled: x.cancelled,
          notFinished: x.notFinished,
          noPlan: x.noPlan,
        })}
      </p>
    </section>
  );
}

export function CompetenceTable({ entries }: { entries: CompetenceEntry[] }) {
  return (
    <section aria-labelledby="competence-title">
      <h3 id="competence-title">{t('competence.title')}</h3>
      <p className="muted small">{t('competence.help')}</p>
      {entries.length === 0 ? (
        <p className="muted">{t('competence.empty')}</p>
      ) : (
        <div className="table-scroll">
          <table className="evidence">
            <caption className="sr-only">{t('competence.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('competence.model')}</th>
                <th scope="col">{t('competence.taskType')}</th>
                <th scope="col">{t('competence.samples')}</th>
                <th scope="col">{t('competence.score')}</th>
                <th scope="col">{t('competence.approved')}</th>
                <th scope="col">{t('competence.evidence')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={`${refKey(e.ref)} ${e.taskType}`}>
                  <th scope="row" className="mono">
                    {refKey(e.ref)}
                  </th>
                  <td>{e.taskType}</td>
                  <td className="num">{e.samples}</td>
                  <td className="num">{formatScore(e.score)}</td>
                  <td className="num">{e.approved}</td>
                  <td>{e.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The "Accuracy & competence" tab: the published accuracy, competence, the run's ROI. */
export function EvidenceView() {
  const conn = useStudio((s) => s.conn);
  const ev = useStudio((s) => s.evidence);
  const run = useStudio(activeRun);
  useEffect(() => {
    if (conn === 'open') void loadEvidence();
  }, [conn]);
  return (
    <div className="evidence-view">
      <button
        type="button"
        disabled={conn !== 'open' || ev.loading}
        onClick={() => void loadEvidence()}
      >
        {ev.loading ? t('runs.loading') : t('evidence.refresh')}
      </button>
      {ev.accuracy ? (
        <AccuracyTable a={ev.accuracy} />
      ) : (
        <p className="muted empty">{t('evidence.empty')}</p>
      )}
      {ev.productivity && <ProductivitySection p={ev.productivity} />}
      {ev.competence && <CompetenceTable entries={ev.competence} />}
      <section aria-labelledby="roi-title">
        <h3 id="roi-title">{t('verify.section')}</h3>
        {run?.verification ? (
          <VerificationLine v={run.verification} />
        ) : (
          <p className="muted">{t('verify.none')}</p>
        )}
      </section>
    </div>
  );
}
