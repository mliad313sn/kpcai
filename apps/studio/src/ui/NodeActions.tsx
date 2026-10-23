/**
 * What the user can do with a node of a run: steer it while live (principle 4, R-304),
 * replay or fork it once finished (R-403), grade it (ADR-0028), and see how a dispute on
 * it was settled (R-405).
 */
import { useState } from 'react';
import { t } from '../i18n/core';
import { gradeNode, nodeKey } from '../store/learning';
import { isTerminal } from '../store/reducer';
import { useStudio } from '../store/store';
import type { NodeRun, RunView } from '../store/types';
import { ForkDialog, type EditMode } from './NodeEditDialog';
import { ReplayDialog } from './ReplayDialog';
import { RunControls } from './RunControls';
import { InstructBox, Redirect } from './Steer';
import { RUN_LIVE } from './view';

const finished = (n: NodeRun | undefined): boolean =>
  !!n && (n.state === 'done' || n.state === 'failed');

export function RunActions({ run, nodeId, n }: { run: RunView; nodeId: string; n?: NodeRun }) {
  const [dialog, setDialog] = useState<EditMode | undefined>();
  const replaying = useStudio((s) => s.replays[nodeKey(run.runId, nodeId)]?.pending === true);
  const conn = useStudio((s) => s.conn);
  const live = RUN_LIVE.has(run.state);
  const notStarted = !n || n.state === 'pending';
  const canReplay = conn === 'open' && !live && finished(n) && !replaying;
  const canFork = conn === 'open' && !live;
  const hint = live ? t('detail.afterRun') : !finished(n) ? t('detail.notFinished') : '';
  return (
    <>
      <div className="row">
        {live && n && !isTerminal(n.state) && <Redirect runId={run.runId} nodeId={nodeId} />}
        <button
          type="button"
          disabled={!canReplay}
          aria-describedby={hint ? 'detail-hint' : undefined}
          onClick={() => setDialog('replay')}
        >
          {replaying ? t('detail.replaying') : t('detail.replay')}
        </button>
        <button
          type="button"
          disabled={!canFork}
          aria-describedby={hint ? 'detail-hint' : undefined}
          onClick={() => setDialog('fork')}
        >
          {t('detail.fork')}
        </button>
        <RunControls run={run} />
      </div>
      {hint && (
        <p id="detail-hint" className="muted small">
          {hint}
        </p>
      )}
      {live && notStarted && <InstructBox runId={run.runId} nodeId={nodeId} />}
      {dialog === 'replay' && (
        <ReplayDialog runId={run.runId} nodeId={nodeId} onClose={() => setDialog(undefined)} />
      )}
      {dialog === 'fork' && (
        <ForkDialog runId={run.runId} nodeId={nodeId} onClose={() => setDialog(undefined)} />
      )}
    </>
  );
}

function GradeButtons(props: {
  current: 'good' | 'bad' | undefined;
  busy: boolean;
  send: (grade: 'good' | 'bad') => void;
}) {
  const { current, busy, send } = props;
  return (
    <div className="row" role="group" aria-label={t('grade.title')}>
      <button
        type="button"
        aria-pressed={current === 'good'}
        disabled={busy}
        onClick={() => send('good')}
      >
        <span aria-hidden="true">✓ </span>
        {t('grade.good')}
      </button>
      <button
        type="button"
        aria-pressed={current === 'bad'}
        disabled={busy}
        onClick={() => send('bad')}
      >
        <span aria-hidden="true">✕ </span>
        {t('grade.bad')}
      </button>
    </div>
  );
}

/** Manual grade (good/bad and a note): journaled with its author, it teaches the router. */
export function GradeBox({ run, nodeId, n }: { run: RunView; nodeId: string; n?: NodeRun }) {
  const g = useStudio((s) => s.grades[nodeKey(run.runId, nodeId)]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (RUN_LIVE.has(run.state) || !finished(n)) return null;
  const send = async (grade: 'good' | 'bad') => {
    setBusy(true);
    if (await gradeNode(run.runId, nodeId, grade, note)) setNote('');
    setBusy(false);
  };
  return (
    <section aria-labelledby="grade-title" className="grade">
      <h4 id="grade-title">{t('grade.title')}</h4>
      <p className="muted small" id="grade-help">
        {t('grade.help')}
      </p>
      <label htmlFor="grade-note">{t('grade.note')}</label>
      <input
        id="grade-note"
        type="text"
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <GradeButtons current={g?.grade} busy={busy} send={(x) => void send(x)} />
      {g && (
        <p className="small" role="status">
          {t(g.grade === 'good' ? 'grade.givenGood' : 'grade.givenBad', { model: g.graded })}
          {g.note ? ` ${t('grade.givenNote', { note: g.note })}` : ''}
        </p>
      )}
    </section>
  );
}

/** How the node's dispute stands: waiting for you, settled with a choice, or rejected. */
export function DisputeNote({ run, nodeId }: { run: RunView; nodeId: string }) {
  const d = run.disputes?.[nodeId];
  if (!d) return null;
  const reason = d.reason ?? t('control.noReason');
  return (
    <p className={d.status === 'rejected' ? 'error-text' : 'warn-text'}>
      <span aria-hidden="true">⚖ </span>
      {d.status === 'open'
        ? t('dispute.open', { reason })
        : d.status === 'chosen'
          ? t('dispute.chosen', { choice: d.choice ?? '—', reason })
          : t('dispute.rejected', { reason })}
    </p>
  );
}
