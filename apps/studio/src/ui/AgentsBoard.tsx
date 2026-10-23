import { t } from '../i18n/core';
import { formatDuration, formatScore, formatUsd } from '../store/format';
import { patch, useStudio } from '../store/store';
import { useNow } from './hooks';
import { StateBadge } from './StateBadge';
import { activeRun, agentRows, type AgentRow } from './view';
import { Zone } from './Zone';

function AgentTable({ rows, now }: { rows: AgentRow[]; now: number }) {
  return (
    <table className="agents">
      <caption className="sr-only">{t('agents.caption')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('agents.model')}</th>
          <th scope="col">{t('agents.node')}</th>
          <th scope="col">{t('agents.elapsed')}</th>
          <th scope="col">{t('agents.cost')}</th>
          <th scope="col">
            <abbr title={t('agents.confTitle')}>{t('agents.conf')}</abbr>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.nodeId} ${r.ref.provider}/${r.ref.model}`}>
            <th scope="row">
              <span className="muted small">{r.ref.provider}/</span>
              <span className="mono">{r.ref.model}</span>
            </th>
            <td>
              <button
                type="button"
                className="link"
                onClick={() => patch({ selectedNodeId: r.nodeId })}
                title={r.title}
              >
                #{r.nodeId}
              </button>{' '}
              · {r.role} <StateBadge state={r.state} />
            </td>
            <td className="num">{formatDuration(now - r.since)}</td>
            <td className="num">{formatUsd(r.costUsd)}</td>
            <td className="num">{formatScore(r.score)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Spec §4.4: who works, on what, since when, for how much, with what confidence. */
export function AgentsBoard() {
  const run = useStudio(activeRun);
  const rows = agentRows(run);
  const now = useNow(1000, rows.length > 0);
  return (
    <Zone zone="agents">
      {rows.length === 0 ? (
        <p className="muted empty">{t('agents.empty')}</p>
      ) : (
        <AgentTable rows={rows} now={now} />
      )}
      {run && (
        <p className="small muted total">{t('agents.total', { cost: formatUsd(run.costUsd) })}</p>
      )}
    </Zone>
  );
}
