import { getLocale, t } from '../i18n/core';
import { controlText } from '../store/controls';
import type { ControlEntry } from '../store/types';

const ICON: Record<string, string> = {
  run_paused: '❚❚',
  run_resumed: '▶',
  run_cancelled: '⊘',
  node_redirected: '↪',
  instruction_added: '✎',
  control_refused: '✕',
  node_disputed: '⚖',
  dispute_resolved: '⚖',
};

function time(at: number): string {
  return new Date(at).toLocaleTimeString(getLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** R-304: the run's steering history in the thread (pause, redirect, instructions…). */
export function ControlLog({ entries }: { entries: ControlEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section className="control-log" aria-labelledby="control-log-title">
      <h3 id="control-log-title" className="sub">
        {t('control.title')}
      </h3>
      <ol>
        {entries.map((c, i) => (
          <li key={i} className={c.event.type === 'control_refused' ? 'error-text' : undefined}>
            <span aria-hidden="true">{ICON[c.event.type] ?? '•'} </span>
            <span className="muted small mono">{time(c.at)}</span> {controlText(c.event)}
          </li>
        ))}
      </ol>
    </section>
  );
}
