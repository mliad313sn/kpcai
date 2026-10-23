/**
 * Tools & skills tab: MCP servers, skills, named agents, hooks (R-501, R-502) and local
 * tickets. Names, descriptions and ticket text come from files in the repository or the
 * user's home: untrusted, shown as text. A ticket is planned like any request, never run
 * straight away.
 */
import { useEffect } from 'react';
import { t } from '../i18n/core';
import { useStudio } from '../store/store';
import { loadTools, planTicket, showTicket, tools, useTools, type Ticket } from '../store/tools';
import { McpPanel } from './McpPanel';

function Origin({ origin, trust }: { origin: string; trust?: string }) {
  return (
    <span className="small muted">
      {t(origin === 'home' ? 'tools.origin.home' : 'tools.origin.repo')}
      {trust === 'untrusted' ? ` · ${t('tools.untrusted')}` : ''}
    </span>
  );
}

function Extensions() {
  const ext = useTools((s) => s.extensions);
  if (!ext) return null;
  const items = [
    ...ext.skills.map((x) => ({ ...x, what: t('tools.kind.skill') })),
    ...ext.agents.map((x) => ({ ...x, what: t('tools.kind.agent') })),
  ];
  return (
    <section className="tools-section" aria-labelledby="ext-h">
      <h3 id="ext-h">{t('tools.ext.title', { count: items.length })}</h3>
      {items.length === 0 ? <p className="muted small">{t('tools.ext.none')}</p> : null}
      <ul className="plain">
        {items.map((x) => (
          <li key={`${x.what}:${x.name}`} className="ext-item">
            <span className="tag">{x.what}</span> <strong className="mono">{x.name}</strong>{' '}
            <Origin origin={x.origin} trust={x.trust} />
            {x.description ? (
              <p className="small">
                <q className="q">{x.description}</q>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <h4>{t('tools.hooks.title', { count: ext.hooks.length })}</h4>
      <ul className="plain small">
        {ext.hooks.map((h) => (
          <li key={`${h.event}:${h.name}`}>
            <span className="tag">{h.event}</span> <strong className="mono">{h.name}</strong>{' '}
            <code className="mono">{h.command}</code> ·{' '}
            {t(h.allowListed ? 'tools.hooks.allowed' : 'tools.hooks.asks')}
          </li>
        ))}
      </ul>
      {ext.problems.map((p, i) => (
        <p key={i} className="small tone-warn">
          {p}
        </p>
      ))}
    </section>
  );
}

function TicketRow({ ticket }: { ticket: Ticket }) {
  return (
    <tr>
      <td className="mono">{ticket.id}</td>
      <th scope="row">
        <q className="q">{ticket.title}</q>
      </th>
      <td>{ticket.status}</td>
      <td className="num">{ticket.criteria.length}</td>
      <td>
        <button type="button" onClick={() => void showTicket(ticket.id)}>
          {t('tools.tickets.show', { id: ticket.id })}
        </button>
      </td>
    </tr>
  );
}

function Shown() {
  const shown = useTools((s) => s.shown);
  if (!shown) return null;
  return (
    <div className="ticket-shown" aria-label={t('tools.tickets.request')} role="region">
      <h4>{t('tools.tickets.request')}</h4>
      <pre className="untrusted">{shown.request}</pre>
      <div className="row end">
        <button type="button" onClick={() => tools.setState({ shown: undefined })}>
          {t('common.close')}
        </button>
        <button type="button" className="primary" onClick={() => void planTicket(shown)}>
          {t('tools.tickets.plan')}
        </button>
      </div>
    </div>
  );
}

function Tickets() {
  const list = useTools((s) => s.tickets);
  const problems = useTools((s) => s.ticketProblems);
  return (
    <section className="tools-section" aria-labelledby="tickets-h">
      <h3 id="tickets-h">{t('tools.tickets.title', { count: list.length })}</h3>
      {list.length === 0 ? (
        <p className="muted small">{t('tools.tickets.none', { dir: '.kpstudio/tickets' })}</p>
      ) : (
        <table className="tickets">
          <caption className="sr-only">{t('tools.tickets.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('tools.tickets.id')}</th>
              <th scope="col">{t('tools.tickets.titleCol')}</th>
              <th scope="col">{t('tools.tickets.status')}</th>
              <th scope="col">{t('tools.tickets.criteria')}</th>
              <th scope="col">
                <span className="sr-only">{t('tools.tickets.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <TicketRow key={x.id} ticket={x} />
            ))}
          </tbody>
        </table>
      )}
      {problems.map((p, i) => (
        <p key={i} className="small tone-warn">
          {p}
        </p>
      ))}
      <Shown />
    </section>
  );
}

export function ToolsView() {
  const conn = useStudio((s) => s.conn);
  const loaded = useTools((s) => s.loaded);
  const loading = useTools((s) => s.loading);
  const errors = useTools((s) => s.errors);
  useEffect(() => {
    if (conn === 'open' && !loaded && !tools.getState().loading) void loadTools();
  }, [conn, loaded]);
  return (
    <div className="tools-view">
      <div className="row">
        <p className="muted small">{t('tools.intro')}</p>
        <button type="button" disabled={loading} onClick={() => void loadTools()}>
          {t('tools.refresh')}
        </button>
      </div>
      {errors.map((e, i) => (
        <p key={i} className="error-text small">
          {t('tools.fail.load', { error: e })}
        </p>
      ))}
      <McpPanel />
      <Extensions />
      <Tickets />
    </div>
  );
}
