import type { NodeState } from '../rpc/schemas';
import type { RunState } from '../store/types';

/** Every state has an icon AND a word; colour only reinforces them (WCAG 1.4.1). */
const STATES: Record<
  NodeState | RunState | 'planned',
  { icon: string; text: string; tone: string }
> = {
  planned: { icon: '◇', text: 'planned', tone: 'muted' },
  pending: { icon: '○', text: 'waiting', tone: 'muted' },
  starting: { icon: '◌', text: 'starting', tone: 'muted' },
  running: { icon: '▶', text: 'running', tone: 'accent' },
  review: { icon: '◑', text: 'in review', tone: 'accent' },
  paused: { icon: '❚❚', text: 'paused', tone: 'warn' },
  cancelling: { icon: '⊘', text: 'cancelling', tone: 'warn' },
  done: { icon: '✓', text: 'done', tone: 'ok' },
  failed: { icon: '✕', text: 'failed', tone: 'danger' },
  skipped: { icon: '↷', text: 'skipped', tone: 'muted' },
  cancelled: { icon: '⊘', text: 'cancelled', tone: 'warn' },
};

export function StateBadge(props: { state: keyof typeof STATES }) {
  const s = STATES[props.state];
  return (
    <span className={`badge tone-${s.tone}`}>
      <span aria-hidden="true" className="badge-icon">
        {s.icon}
      </span>
      {s.text}
    </span>
  );
}
