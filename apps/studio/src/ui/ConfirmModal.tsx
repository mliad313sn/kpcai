import { t, type Key } from '../i18n/core';
import { answerConfirm } from '../store/actions';
import { rejectProposal } from '../store/memory';
import { useStudio } from '../store/store';
import type { ConfirmView } from '../store/types';
import { PatchText } from './DiffView';
import { TimeLeft, useConfirmDeadline } from './ConfirmParts';
import { DisputeDialog } from './DisputeDialog';
import { MemoryFact } from './MemoryFact';
import { Modal } from './Modal';

const RISK: Record<NonNullable<ConfirmView['risk']>, { icon: string; key: Key }> = {
  read: { icon: '◎', key: 'confirm.risk.read' },
  write: { icon: '✎', key: 'confirm.risk.write' },
  destructive: { icon: '⚠', key: 'confirm.risk.destructive' },
};

const TITLES: Record<ConfirmView['kind'], Key> = {
  budget: 'confirm.title.budget',
  tool: 'confirm.title.tool',
  patch: 'confirm.title.patch',
  restore: 'confirm.title.restore',
  artifact: 'confirm.title.artifact',
  memory: 'confirm.title.memory',
  dispute: 'confirm.title.dispute',
};

/** What a write would put on disk: the diff, or an artifact's exact text and metadata. */
function Payload({ c }: { c: ConfirmView }) {
  if (c.patch !== undefined)
    return (
      <section aria-label={t('confirm.patchRegion')} className="confirm-patch">
        <p className="muted">{t('confirm.patchExact')}</p>
        <PatchText patch={c.patch} />
      </section>
    );
  if (c.content === undefined) return null;
  const a = c.artifact;
  return (
    <section aria-label={t('confirm.contentRegion')} className="confirm-patch">
      {a?.reviewed === false && (
        <p className="warn-text">
          <span aria-hidden="true">⚠ </span>
          {t('artifacts.unreviewedLong')}
        </p>
      )}
      {a && (
        <p className="muted">
          {t('confirm.artifactMeta', { path: a.path, kind: a.kind, mime: a.mime, bytes: a.bytes })}
        </p>
      )}
      <pre className="output" tabIndex={0}>
        {c.content}
      </pre>
    </section>
  );
}

/**
 * A server confirmation (tool permission, budget, patch). The default is No: Escape, the
 * close button and the timeout all decline. The question (and a patch) is shown exactly
 * as received, as text.
 */
export function ConfirmModal() {
  const current = useStudio((s) => s.confirms[0]);
  const queued = useStudio((s) => s.confirms.length - 1);
  if (!current) return null;
  if (current.kind === 'dispute' && current.dispute)
    return <DisputeDialog key={current.confirmId} c={current} queued={queued} />;
  return <ConfirmDialog key={current.confirmId} c={current} queued={queued} />;
}

/** A model's proposed fact (ADR-0027): keep it, leave it pending (default), or reject it. */
function MemoryButtons({ c }: { c: ConfirmView }) {
  const id = c.memory!.id;
  return (
    <div className="row end">
      <button
        type="button"
        className="confirm-no"
        onClick={() => void answerConfirm(c.confirmId, false)}
      >
        {t('memory.later')}
      </button>
      <button
        type="button"
        className="danger"
        onClick={() => void answerConfirm(c.confirmId, false).then(() => rejectProposal(id))}
      >
        {t('memory.reject')}
      </button>
      <button
        type="button"
        className="primary"
        onClick={() => void answerConfirm(c.confirmId, true)}
      >
        {t('memory.keep')}
      </button>
    </div>
  );
}

function ConfirmDialog({ c, queued }: { c: ConfirmView; queued: number }) {
  const deadline = useConfirmDeadline(c);
  const no = () => void answerConfirm(c.confirmId, false);
  const risk = c.risk ? RISK[c.risk] : undefined;
  return (
    <Modal
      role="alertdialog"
      labelledBy="confirm-title"
      describedBy="confirm-question"
      onClose={no}
      initialFocus=".confirm-no"
      className={`confirm risk-${c.risk ?? 'none'}`}
    >
      <h2 id="confirm-title">{t(TITLES[c.kind])}</h2>
      {risk && (
        <p className="risk">
          <span aria-hidden="true">{risk.icon}</span> {t('confirm.risk', { risk: t(risk.key) })}
        </p>
      )}
      <pre id="confirm-question" className="confirm-question" tabIndex={0}>
        {c.question}
      </pre>
      <Payload c={c} />
      {c.memory && <MemoryFact m={c.memory} />}
      <TimeLeft
        deadline={deadline}
        queued={queued}
        {...(c.memory ? { text: 'memory.timeout' as const } : {})}
      />
      {c.memory ? <MemoryButtons c={c} /> : <YesNo c={c} no={no} />}
    </Modal>
  );
}

function YesNo({ c, no }: { c: ConfirmView; no: () => void }) {
  return (
    <div className="row end">
      <button type="button" className="confirm-no" onClick={no}>
        {t('confirm.no')}
      </button>
      <button
        type="button"
        className={c.risk === 'destructive' ? 'danger' : 'primary'}
        onClick={() => void answerConfirm(c.confirmId, true)}
      >
        {t('confirm.yes')}
      </button>
    </div>
  );
}
