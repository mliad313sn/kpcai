/**
 * Small pieces of the Enterprise view. Every state is an icon AND a word (WCAG 1.4.1);
 * colour only reinforces it. Text from programs, seats and runs is untrusted: it is shown
 * as React text inside quotes, never as markup.
 */
import { getLocale, t, type Key } from '../../i18n/core';
import type { Assurance, Health, SeatState, Source } from '../../enterprise/schemas';
import { ASSURANCE_KEY as ASSURANCE } from '../../enterprise/words';

interface Look {
  icon: string;
  key: Key;
  tone: string;
}

/** `︎` asks for the text form of a symbol, never a colour emoji. */
const SEAT: Record<SeatState, Look> = {
  idle: { icon: '○', key: 'ent.seat.idle', tone: 'muted' },
  thinking: { icon: '◌', key: 'ent.seat.thinking', tone: 'accent' },
  writing: { icon: '✎︎', key: 'ent.seat.writing', tone: 'accent' },
  reviewing: { icon: '◑', key: 'ent.seat.reviewing', tone: 'accent' },
  waiting_for_you: { icon: '◆', key: 'ent.seat.waiting', tone: 'warn' },
  blocked: { icon: '✕', key: 'ent.seat.blocked', tone: 'danger' },
};

const SOURCE: Record<Source, Look> = {
  local: { icon: '⌂', key: 'ent.source.local', tone: 'local' },
  api: { icon: '☁︎', key: 'ent.source.api', tone: 'api' },
  subscription: { icon: '⎘', key: 'ent.source.subscription', tone: 'sub' },
};

const HEALTH: Record<Health, Look> = {
  on_track: { icon: '✓', key: 'ent.health.on_track', tone: 'ok' },
  at_risk: { icon: '◐', key: 'ent.health.at_risk', tone: 'warn' },
  blocked: { icon: '✕', key: 'ent.health.blocked', tone: 'danger' },
};

const PROGRAM: Record<string, Look> = {
  draft: { icon: '◇', key: 'ent.status.draft', tone: 'muted' },
  proposed: { icon: '◇', key: 'ent.status.proposed', tone: 'muted' },
  approved: { icon: '◈', key: 'ent.status.approved', tone: 'accent' },
  running: { icon: '▶', key: 'ent.status.running', tone: 'accent' },
  gate: { icon: '⛩︎', key: 'ent.status.gate', tone: 'accent' },
  paused: { icon: '❚❚', key: 'ent.status.paused', tone: 'warn' },
  stopped: { icon: '■', key: 'ent.status.stopped', tone: 'muted' },
  delivered: { icon: '✓', key: 'ent.status.delivered', tone: 'ok' },
};

export { ASSURANCE };

const KIND_ICON: Record<string, string> = {
  architect: '◇',
  builder: '▣',
  specialist: '✦',
  security: '◈',
  qa: '☑︎',
  reviewer: '◎',
};

export const kindIcon = (kind: string): string => KIND_ICON[kind] ?? '●';

function Badge({ look, label }: { look: Look; label?: string }) {
  return (
    <span className={`badge tone-${look.tone}`}>
      <span aria-hidden="true" className="badge-icon">
        {look.icon}
      </span>
      {label ?? t(look.key)}
    </span>
  );
}

export const seatStateLabel = (s: SeatState): string => t(SEAT[s].key);
export const sourceLabel = (s: Source): string => t(SOURCE[s].key);

export function SeatStateBadge({ state }: { state: SeatState }) {
  return <Badge look={SEAT[state]} />;
}

export function SourceBadge({ source }: { source: Source | undefined }) {
  if (!source) return <span className="badge tone-muted">{t('ent.source.unknown')}</span>;
  return <Badge look={SOURCE[source]} />;
}

export function HealthBadge({ health }: { health: Health }) {
  return <Badge look={HEALTH[health]} />;
}

export function programStatusLabel(status: string): string {
  const look = PROGRAM[status];
  return look ? t(look.key) : status;
}

export function ProgramStatusBadge({ status }: { status: string }) {
  const look = PROGRAM[status] ?? { icon: '●', key: 'ent.status.draft' as Key, tone: 'muted' };
  return <Badge look={look} label={programStatusLabel(status)} />;
}

export function AssuranceBadge({ label, why }: { label: Assurance; why?: string | undefined }) {
  return (
    <span className={`badge assurance assurance-${label}`}>
      <strong>{label}</strong> {t(ASSURANCE[label])}
      {why ? <span className="muted"> · {why}</span> : null}
    </span>
  );
}

/** Untrusted text, quoted. `<q>` adds the language's quotation marks. */
export function Quoted({ text, className }: { text: string; className?: string }) {
  return <q className={`q ${className ?? ''}`}>{text}</q>;
}

export { formatAge } from '../../enterprise/words';

/** Time of day of an ISO timestamp in the display language (HH:MM:SS). */
export function clock(iso: string): string {
  const d = new Date(iso);
  const tag = getLocale() === 'fr' ? 'fr-FR' : 'en-GB';
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString(tag, { hour12: false });
}
