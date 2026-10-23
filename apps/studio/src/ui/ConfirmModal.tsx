import { useEffect } from 'react';
import { t, type Key } from '../i18n/core';
import { answerConfirm } from '../store/actions';
import { formatDuration } from '../store/format';
import { useStudio } from '../store/store';
import type { ConfirmView } from '../store/types';
import { PatchText } from './DiffView';
import { useNow } from './hooks';
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
  return <ConfirmDialog key={current.confirmId} c={current} queued={queued} />;
}

function ConfirmDialog({ c, queued }: { c: ConfirmView; queued: number }) {
  const now = useNow(250);
  const deadline = c.receivedAt + c.timeoutMs;
  useEffect(() => {
    const t = setTimeout(() => void answerConfirm(c.confirmId, false), deadline - Date.now());
    return () => clearTimeout(t);
  }, [c.confirmId, deadline]);
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
      <p className="muted" aria-live="off">
        {t('confirm.timeout', { time: formatDuration(Math.max(0, deadline - now)) })}
        {queued > 0 ? ` · ${t('confirm.queued', { count: queued })}` : ''}
      </p>
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
    </Modal>
  );
}
