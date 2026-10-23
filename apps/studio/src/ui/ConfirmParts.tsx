/** Shared by the confirmation dialogs: the timeout (silence is a no) and the time left. */
import { useEffect } from 'react';
import { t, type Key } from '../i18n/core';
import { answerConfirm } from '../store/actions';
import { formatDuration } from '../store/format';
import type { ConfirmView } from '../store/types';
import { useNow } from './hooks';

/** Silence is a no: the confirmation is declined when its time is up. Returns the deadline. */
export function useConfirmDeadline(c: ConfirmView): number {
  const deadline = c.receivedAt + c.timeoutMs;
  useEffect(() => {
    const t = setTimeout(() => void answerConfirm(c.confirmId, false), deadline - Date.now());
    return () => clearTimeout(t);
  }, [c.confirmId, deadline]);
  return deadline;
}

/** The time left and the queue, below every confirmation. */
export function TimeLeft(props: { deadline: number; queued: number; text?: Key }) {
  const { deadline, queued, text = 'confirm.timeout' } = props;
  const now = useNow(250);
  return (
    <p className="muted" aria-live="off">
      {t(text, { time: formatDuration(Math.max(0, deadline - now)) })}
      {queued > 0 ? ` · ${t('confirm.queued', { count: queued })}` : ''}
    </p>
  );
}
