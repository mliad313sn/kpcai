import { useEffect } from 'react';
import { answerConfirm } from '../store/actions';
import { formatDuration } from '../store/format';
import { useStudio } from '../store/store';
import type { ConfirmView } from '../store/types';
import { useNow } from './hooks';
import { Modal } from './Modal';

const RISK: Record<NonNullable<ConfirmView['risk']>, { icon: string; text: string }> = {
  read: { icon: '◎', text: 'Read only' },
  write: { icon: '✎', text: 'Writes files' },
  destructive: { icon: '⚠', text: 'Destructive' },
};

const TITLES: Record<ConfirmView['kind'], string> = {
  budget: 'Budget confirmation',
  tool: 'Tool permission',
  patch: 'Apply patch?',
};

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
      <h2 id="confirm-title">{TITLES[c.kind]}</h2>
      {risk && (
        <p className="risk">
          <span aria-hidden="true">{risk.icon}</span> Risk: <strong>{risk.text}</strong>
        </p>
      )}
      {c.kind === 'patch' && <p className="muted">Patch text exactly as received:</p>}
      <pre id="confirm-question" className="confirm-question" tabIndex={0}>
        {c.question}
      </pre>
      <p className="muted" aria-live="off">
        Answers No automatically in {formatDuration(Math.max(0, deadline - now))}
        {queued > 0 ? ` · ${queued} more waiting` : ''}
      </p>
      <div className="row end">
        <button type="button" className="confirm-no" onClick={no}>
          No
        </button>
        <button
          type="button"
          className={c.risk === 'destructive' ? 'danger' : 'primary'}
          onClick={() => void answerConfirm(c.confirmId, true)}
        >
          Yes, allow
        </button>
      </div>
    </Modal>
  );
}
