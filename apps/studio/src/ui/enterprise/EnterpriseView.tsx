/**
 * The Enterprise view (R-5E10, design §14.3): how the whole virtual enterprise works, at a
 * glance. Gauges across the top; programs and your decisions on the left, always visible
 * so pause, resume and stop stay one action away; the team, the live activity and the
 * reports on the right. "Stop everything" is always in the header (Simplicity Charter §2).
 */
import { useRef } from 'react';
import { t, type Key } from '../../i18n/core';
import { summaryCounts } from '../../enterprise/derive';
import { kill, loadSnapshot, unkill } from '../../enterprise/actions';
import { patchUi, useEnt, type EntPane } from '../../enterprise/store';
import { ActivityFeed } from './Activity';
import { Gauges } from './Gauges';
import { HeartbeatBadge, HeartbeatBanner } from './Heartbeat';
import { Inbox } from './Inbox';
import { OrgMap } from './OrgMap';
import { Portfolio } from './Portfolio';
import { ReportsArchive } from './Reports';

const PANES: Array<{ id: EntPane; label: Key }> = [
  { id: 'org', label: 'ent.pane.org' },
  { id: 'activity', label: 'ent.pane.activity' },
  { id: 'reports', label: 'ent.pane.reports' },
];

function Summary() {
  // A string selector: the component re-renders only when the sentence changes.
  const text = useEnt((s) => {
    const c = summaryCounts(s.data);
    return t('ent.summary', {
      programs: c.programs,
      seats: c.seats.total,
      working: c.seats.working,
      waiting: c.seats.waiting,
      blocked: c.seats.blocked,
      asks: c.asks,
    });
  });
  // Polite and coarse (R12): the counts, never per-seat chatter.
  return (
    <p className="ent-summary small" role="status" aria-live="polite">
      {text}
    </p>
  );
}

function KillSwitch() {
  const killed = useEnt((s) => s.data.killSwitch);
  const busy = useEnt((s) => !!s.ui.busy['portfolio']);
  if (killed)
    return (
      <span className="row">
        <span className="badge tone-danger">
          <span aria-hidden="true" className="badge-icon">
            ■
          </span>
          {t('ent.kill.on')}
        </span>
        <button type="button" disabled={busy} onClick={() => void unkill()}>
          {t('ent.kill.undo')}
        </button>
      </span>
    );
  return (
    <button type="button" className="danger stop-all" disabled={busy} onClick={() => void kill()}>
      <span aria-hidden="true">■ </span>
      {t('ent.kill.button')}
    </button>
  );
}

function PaneTabs({ pane }: { pane: EntPane }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const n = PANES.length;
    const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    patchUi({ pane: PANES[to]!.id });
    refs.current[to]?.focus();
  };
  return (
    <div role="tablist" aria-label={t('ent.pane.list')} className="tabs">
      {PANES.map((p, i) => (
        <button
          key={p.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`ent-tab-${p.id}`}
          aria-selected={pane === p.id}
          aria-controls={`ent-panel-${p.id}`}
          tabIndex={pane === p.id ? 0 : -1}
          onClick={() => patchUi({ pane: p.id })}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {t(p.label)}
        </button>
      ))}
    </div>
  );
}

function RightPane() {
  const pane = useEnt((s) => s.ui.pane);
  return (
    <section className="ent-right panel" aria-label={t('ent.pane.region')}>
      <PaneTabs pane={pane} />
      <div
        role="tabpanel"
        id={`ent-panel-${pane}`}
        aria-labelledby={`ent-tab-${pane}`}
        className="ent-tabpanel"
      >
        {pane === 'org' && <OrgMap />}
        {pane === 'activity' && <ActivityFeed />}
        {pane === 'reports' && <ReportsArchive />}
      </div>
    </section>
  );
}

function Body() {
  return (
    <>
      <Gauges />
      <div className="ent-grid">
        <div className="ent-left">
          <Inbox />
          <Portfolio />
        </div>
        <RightPane />
      </div>
    </>
  );
}

function StatusBody() {
  const status = useEnt((s) => s.ui.status);
  const error = useEnt((s) => s.ui.error);
  if (status === 'ready') return <Body />;
  if (status === 'unavailable')
    return (
      <div className="ent-empty">
        <h3>{t('ent.unavailable.title')}</h3>
        <p>{t('ent.unavailable.body', { command: 'kpai serve --headless' })}</p>
      </div>
    );
  if (status === 'error')
    return (
      <div className="ent-empty">
        <p className="error-text">{t('ent.error.load', { error: error ?? '' })}</p>
        <button type="button" onClick={() => void loadSnapshot()}>
          {t('ent.error.retry')}
        </button>
      </div>
    );
  return <p className="muted empty">{t('ent.loading')}</p>;
}

/** The snapshot is loaded by the App for every tier (`useEnterpriseWatch`). */
export function EnterpriseView() {
  const ready = useEnt((s) => s.ui.status === 'ready');
  return (
    <main className="enterprise" aria-labelledby="ent-title">
      <div className="ent-head">
        <h2 id="ent-title" tabIndex={-1}>
          {t('ent.title')}
        </h2>
        {ready ? <HeartbeatBadge /> : null}
        {ready ? <Summary /> : null}
        <span className="spacer" />
        {ready ? <KillSwitch /> : null}
      </div>
      {ready ? <HeartbeatBanner /> : null}
      <StatusBody />
    </main>
  );
}
