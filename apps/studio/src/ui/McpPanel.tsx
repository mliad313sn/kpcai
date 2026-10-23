/**
 * MCP servers (R-501, ADR-0032): each allow-listed server with its pin state. A blocked
 * server's calls are all refused until a person approves its current form; the panel says
 * what changed when the kernel tells it, and otherwise names the command that shows it.
 */
import { t, type Key } from '../i18n/core';
import { approveServer, tools, useTools, type McpServerRow, type McpState } from '../store/tools';
import { Modal } from './Modal';

const LOOK: Record<McpState, { icon: string; tone: string; key: Key }> = {
  approved: { icon: '✓', tone: 'ok', key: 'tools.mcp.state.approved' },
  unapproved: { icon: '◇', tone: 'warn', key: 'tools.mcp.state.unapproved' },
  changed: { icon: '⚠︎', tone: 'danger', key: 'tools.mcp.state.changed' },
  blocked: { icon: '⊘', tone: 'danger', key: 'tools.mcp.state.blocked' },
  unreachable: { icon: '○', tone: 'muted', key: 'tools.mcp.state.unreachable' },
};

const needsApproval = (r: McpServerRow): boolean =>
  r.status === 'unapproved' || r.status === 'changed' || r.status === 'blocked';

function WhatChanged({ row }: { row: McpServerRow }) {
  if (!needsApproval(row)) return null;
  return (
    <div className="what-changed">
      <p className="small">
        <strong>{t('tools.mcp.whatChanged')}</strong>
      </p>
      {row.changes.length ? (
        <ul className="small">
          {row.changes.map((c, i) => (
            <li key={i}>
              <q className="q">{c}</q>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">{t('tools.mcp.changesUnknown')}</p>
      )}
      {row.blockedTools.length ? (
        <p className="small">
          {t('tools.mcp.blockedTools', { count: row.blockedTools.length })}{' '}
          <span className="mono">{row.blockedTools.join(', ')}</span>
        </p>
      ) : null}
      <p className="small">
        {t('tools.mcp.howTo')} <code className="mono">kpai mcp approve {row.server}</code>
      </p>
    </div>
  );
}

function ServerCard({ row, canApprove }: { row: McpServerRow; canApprove: boolean }) {
  const look = LOOK[row.status];
  return (
    <li className={`mcp-server mcp-${row.status}`}>
      <article aria-labelledby={`mcp-${row.server}`}>
        <div className="row">
          <h4 id={`mcp-${row.server}`} className="mono">
            {row.server}
          </h4>
          <span className={`badge tone-${look.tone}`}>
            <span aria-hidden="true" className="badge-icon">
              {look.icon}
            </span>
            {t(look.key)}
          </span>
        </div>
        <p className="small muted">
          {t('tools.mcp.tools', { count: row.tools.length })}
          {row.version ? ` · ${t('tools.mcp.version', { version: row.version })}` : ''}
          {' · '}
          {row.egress.length
            ? t('tools.mcp.egress', { hosts: row.egress.join(', ') })
            : t('tools.mcp.noEgress')}
        </p>
        {row.reason ? (
          <p className="small">
            <q className="q">{row.reason}</q>
          </p>
        ) : null}
        <WhatChanged row={row} />
        {canApprove && needsApproval(row) ? (
          <div className="row end">
            <button type="button" onClick={() => tools.setState({ approveAsk: row.server })}>
              {t('tools.mcp.approve')}
            </button>
          </div>
        ) : null}
      </article>
    </li>
  );
}

function ApproveDialog() {
  const row = useTools((s) => s.mcp.find((r) => r.server === s.approveAsk));
  if (!row) return null;
  const close = () => tools.setState({ approveAsk: undefined });
  return (
    <Modal labelledBy="mcp-approve-title" role="alertdialog" onClose={close} initialFocus="#mcp-no">
      <h2 id="mcp-approve-title">{t('tools.mcp.approveTitle', { server: row.server })}</h2>
      <p>{t('tools.mcp.approveBody', { count: row.tools.length, version: row.version ?? '—' })}</p>
      <ul className="small">
        {row.changes.map((c, i) => (
          <li key={i}>
            <q className="q">{c}</q>
          </li>
        ))}
      </ul>
      <p className="small mono">
        {row.hash ? t('tools.mcp.hash', { hash: row.hash.slice(0, 16) }) : ''}
      </p>
      <div className="row end">
        <button id="mcp-no" type="button" onClick={close}>
          {t('common.cancel')}
        </button>
        <button type="button" className="primary" onClick={() => void approveServer(row)}>
          {t('tools.mcp.approveYes')}
        </button>
      </div>
    </Modal>
  );
}

export function McpPanel() {
  const rows = useTools((s) => s.mcp);
  const from = useTools((s) => s.mcpFrom);
  const other = useTools((s) => s.otherTools);
  return (
    <section className="tools-section" aria-labelledby="mcp-h">
      <h3 id="mcp-h">{t('tools.mcp.title', { count: rows.length })}</h3>
      <p className="small muted">
        {t('tools.mcp.intro', { count: other })} {from === 'tools' ? t('tools.mcp.readOnly') : null}
      </p>
      {rows.length === 0 ? (
        <p className="muted small">{t('tools.mcp.none', { file: '$KPAI_HOME/mcp.json' })}</p>
      ) : (
        <ul className="plain cards">
          {rows.map((r) => (
            <ServerCard key={r.server} row={r} canApprove={from === 'status'} />
          ))}
        </ul>
      )}
      <ApproveDialog />
    </section>
  );
}
