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
          <span className="sr-only">Refresh sessions</span>
        </button>
      }
    >
      <h3 className="sub">Sessions</h3>
      {sessions.length === 0 ? (
        <p className="muted empty">No sessions yet. Your first KP Studio run will appear here.</p>
      ) : (
        <ul className="sessions">
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="session-title" title={s.title}>
                {s.title || '(untitled)'}
              </span>
              <span className="muted small">
                {when(s.createdAt)}
                {s.costUsd !== undefined ? ` · ${formatUsd(s.costUsd)}` : ''}
                {s.eventCount !== undefined ? ` · ${s.eventCount} events` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3 className="sub">Files</h3>
      <p className="muted empty">File tree arrives in phase 5.</p>
    </Zone>
  );
}
