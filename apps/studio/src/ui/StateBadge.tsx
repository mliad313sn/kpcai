import { t, type Key } from '../i18n/core';
import type { NodeState } from '../rpc/schemas';
import type { RunState } from '../store/types';

/** Every state has an icon AND a word; colour only reinforces them (WCAG 1.4.1). */
const STATES: Record<NodeState | RunState | 'planned', { icon: string; key: Key; tone: string }> = {
  planned: { icon: '◇', key: 'state.planned', tone: 'muted' },
  pending: { icon: '○', key: 'state.waiting', tone: 'muted' },
  starting: { icon: '◌', key: 'state.starting', tone: 'muted' },
  running: { icon: '▶', key: 'state.running', tone: 'accent' },
  review: { icon: '◑', key: 'state.in_review', tone: 'accent' },
  paused: { icon: '❚❚', key: 'state.paused', tone: 'warn' },
  cancelling: { icon: '⊘', key: 'state.cancelling', tone: 'warn' },
  done: { icon: '✓', key: 'state.done', tone: 'ok' },
  failed: { icon: '✕', key: 'state.failed', tone: 'danger' },
  skipped: { icon: '↷', key: 'state.skipped', tone: 'muted' },
  cancelled: { icon: '⊘', key: 'state.cancelled', tone: 'warn' },
};

export type BadgeState = keyof typeof STATES;

/** The state's word in the current language (window title, tables). */
export function stateLabel(state: BadgeState): string {
  return t(STATES[state].key);
}

export function StateBadge(props: { state: keyof typeof STATES }) {
  const s = STATES[props.state];
  return (
    <span className={`badge tone-${s.tone}`}>
      <span aria-hidden="true" className="badge-icon">
        {s.icon}
      </span>
      {t(s.key)}
    </span>
  );
}
