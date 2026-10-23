/**
 * Portfolio board (design §14.3): one card per program with its phases on a timeline, the
 * current gate, its work packages, health and the next decision expected from you. Pause,
 * resume and stop are on every card, one action away (stop asks once: it is final).
 */
import { t, type Key } from '../../i18n/core';
import { ENDED_PROGRAM, PAUSED_PROGRAM } from '../../enterprise/derive';
import type { WpState } from '../../enterprise/schemas';
import type { ProgramView as ProgramCard } from '../../enterprise/state';
import { programControl } from '../../enterprise/actions';
import { patchUi, useEnt } from '../../enterprise/store';
import { Modal } from '../Modal';
import { HealthBadge, ProgramStatusBadge, Quoted } from './parts';

const PHASE_ICON = { done: '✓', current: '▶', next: '○' } as const;
const WP_ORDER: WpState[] = ['running', 'review', 'queued', 'held', 'done'];
const WP_KEY: Record<WpState, Key> = {
  queued: 'ent.wp.queued',
  running: 'ent.wp.running',
  review: 'ent.wp.review',
  done: 'ent.wp.done',
  held: 'ent.wp.held',
};

function Phases({ p }: { p: ProgramCard }) {
  if (p.phases.length === 0) return null;
  return (
    <ol className="phases" aria-label={t('ent.program.phases')}>
      {p.phases.map((ph) => (
        <li
          key={ph.id}
          className={`phase phase-${ph.state}`}
          aria-current={ph.state === 'current' ? 'step' : undefined}
        >
          <span aria-hidden="true">{PHASE_ICON[ph.state]} </span>
          {ph.title}
          <span className="sr-only"> ({t(`ent.phase.${ph.state}`)})</span>
        </li>
      ))}
    </ol>
  );
}

function Wps({ p }: { p: ProgramCard }) {
  const wps = p.wps ?? [];
  if (wps.length === 0) return null;
  const counts = WP_ORDER.map((s) => [s, wps.filter((w) => w.state === s).length] as const);
  return (
    <p className="small wps">
      <span className="muted">{t('ent.program.wps')}</span>{' '}
      {counts
        .filter(([, n]) => n > 0)
        .map(([s, n]) => (
          <span key={s} className={`tag wp-${s}`}>
            {t(WP_KEY[s], { count: n })}
          </span>
        ))}
    </p>
  );
}

function Controls({ p }: { p: ProgramCard }) {
  const busy = useEnt((s) => s.ui.busy[p.programId]);
  if (ENDED_PROGRAM.has(p.status)) return null;
  const paused = PAUSED_PROGRAM.has(p.status);
  const name = p.programId;
  return (
    <div className="row end program-controls">
      {paused ? (
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void programControl(name, 'resume')}
          aria-label={t('ent.program.resumeLabel', { program: name })}
        >
          {t('ent.program.resume')}
        </button>
      ) : (
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void programControl(name, 'pause')}
          aria-label={t('ent.program.pauseLabel', { program: name })}
        >
          {t('ent.program.pause')}
        </button>
      )}
      <button
        type="button"
        className="danger"
        disabled={!!busy}
        onClick={() => patchUi({ stopAsk: name })}
        aria-label={t('ent.program.stopLabel', { program: name })}
      >
        {t('ent.program.stop')}
      </button>
    </div>
  );
}

function Card({ p }: { p: ProgramCard }) {
  return (
    <li className={`program health-${p.health}`}>
      <article aria-labelledby={`prog-${p.programId}`}>
        <div className="row">
          <h4 id={`prog-${p.programId}`} className="mono">
            {p.programId}
          </h4>
          <span className="row">
            <ProgramStatusBadge status={p.status} />
            <HealthBadge health={p.health} />
          </span>
        </div>
        <p>
          <Quoted text={p.goal} />
        </p>
        <Phases p={p} />
        {p.gate ? (
          <p className="small">
            {p.gate.verdict
              ? t('ent.program.gateVerdict', { phase: p.gate.phaseId, verdict: p.gate.verdict })
              : t('ent.program.gateOpen', { phase: p.gate.phaseId })}
          </p>
        ) : null}
        <Wps p={p} />
        {p.pausedReason ? (
          <p className="small tone-warn">
            {t('ent.program.pausedBecause')} <Quoted text={p.pausedReason} />
          </p>
        ) : null}
        {p.expires ? (
          <p className="small muted">
            {t('ent.program.expires', { date: p.expires.slice(0, 10) })}
          </p>
        ) : null}
        {p.nextDecision ? (
          <p className="small next-decision">
            <span className="tone-warn">{t('ent.program.yourDecision')}</span>{' '}
            <a href={`#ask-${p.nextDecision.escalationId}`}>
              <Quoted text={p.nextDecision.question} />
            </a>
          </p>
        ) : null}
        <Controls p={p} />
      </article>
    </li>
  );
}

function StopConfirm() {
  const programId = useEnt((s) => s.ui.stopAsk);
  if (!programId) return null;
  const close = () => patchUi({ stopAsk: undefined });
  return (
    <Modal
      labelledBy="stop-title"
      describedBy="stop-body"
      role="alertdialog"
      onClose={close}
      initialFocus="#stop-cancel"
    >
      <h2 id="stop-title">{t('ent.stop.title', { program: programId })}</h2>
      <p id="stop-body">{t('ent.stop.body')}</p>
      <div className="row end">
        <button id="stop-cancel" type="button" onClick={close}>
          {t('ent.stop.keep')}
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void programControl(programId, 'stop')}
        >
          {t('ent.stop.confirm')}
        </button>
      </div>
    </Modal>
  );
}

export function Portfolio() {
  const programs = useEnt((s) => s.data.programs);
  return (
    <section className="portfolio panel" aria-labelledby="ent-portfolio-h">
      <h3 id="ent-portfolio-h">{t('ent.portfolio.title', { count: programs.length })}</h3>
      {programs.length === 0 ? (
        <p className="muted empty">{t('ent.portfolio.empty')}</p>
      ) : (
        <ul className="programs plain">
          {programs.map((p) => (
            <Card key={p.programId} p={p} />
          ))}
        </ul>
      )}
      <StopConfirm />
    </section>
  );
}
