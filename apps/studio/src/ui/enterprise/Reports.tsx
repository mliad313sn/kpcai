/** Reports archive (design §14.3): every report sent, its kind, channels and program. */
import { t, type Key } from '../../i18n/core';
import { useEnt } from '../../enterprise/store';
import { Quoted, clock } from './parts';

const KIND: Record<string, Key> = {
  digest: 'ent.report.digest',
  gate: 'ent.report.gate',
  milestone: 'ent.report.milestone',
  final: 'ent.report.final',
  exception: 'ent.report.exception',
  heartbeat: 'ent.report.heartbeat',
};

const kindLabel = (k: string): string => (KIND[k] ? t(KIND[k]) : k);

function day(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${d.toISOString().slice(0, 10)} ${clock(iso)}`;
}

export function ReportsArchive() {
  const reports = useEnt((s) => s.data.reports);
  if (reports.length === 0) return <p className="muted empty">{t('ent.reports.empty')}</p>;
  return (
    <div className="reports-scroll">
      <table className="reports">
        <caption className="sr-only">{t('ent.reports.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('ent.reports.when')}</th>
            <th scope="col">{t('ent.reports.program')}</th>
            <th scope="col">{t('ent.reports.kind')}</th>
            <th scope="col">{t('ent.reports.title')}</th>
            <th scope="col">{t('ent.reports.channels')}</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.reportId} id={`report-${r.reportId}`}>
              <td className="mono small">{day(r.at)}</td>
              <td className="mono">{r.programId}</td>
              <td>{kindLabel(r.kind)}</td>
              <th scope="row">
                <Quoted text={r.title} />
              </th>
              <td>{r.channels.length ? r.channels.join(', ') : t('ent.reports.archiveOnly')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
