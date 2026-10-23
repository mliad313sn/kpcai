import { t } from '../i18n/core';
import { loadSessions } from '../store/actions';
import { formatUsd } from '../store/format';
import { useStudio } from '../store/store';
import { Zone } from './Zone';

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Phase 3: sessions from the journal. Files and tickets arrive in phase 5. */
export function Explorer() {
  const sessions = useStudio((s) => s.sessions);
  const conn = useStudio((s) => s.conn);
  return (
    <Zone
      zone="explorer"
      actions={
        <button
          type="button"
          className="icon-btn"
          disabled={conn !== 'open'}
          onClick={() => void loadSessions()}
        >
          <span aria-hidden="true">↻</span>
          <span className="sr-only">{t('explorer.refresh')}</span>
        </button>
      }
    >
      <h3 className="sub">{t('explorer.sessions')}</h3>
      {sessions.length === 0 ? (
        <p className="muted empty">{t('explorer.noSessions')}</p>
      ) : (
        <ul className="sessions">
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="session-title" title={s.title}>
                {s.title || t('explorer.untitled')}
              </span>
              <span className="muted small">
                {when(s.createdAt)}
                {s.costUsd !== undefined ? ` · ${formatUsd(s.costUsd)}` : ''}
                {s.eventCount !== undefined
                  ? ` · ${t('explorer.events', { count: s.eventCount })}`
                  : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3 className="sub">{t('explorer.files')}</h3>
      <p className="muted empty">{t('explorer.filesLater')}</p>
    </Zone>
  );
}
