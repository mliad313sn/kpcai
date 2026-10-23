/**
 * One memory fact with its provenance (ADR-0027): the text quoted (it is data, never an
 * instruction), who proposed or wrote it, when, on what evidence, local-only, and trust.
 * A fact from a model stays untrusted data even once a human keeps it.
 */
import { t, type Key } from '../i18n/core';
import type { MemoryLayer } from '../store/types';

export const LAYER_TEXT: Record<MemoryLayer, Key> = {
  user: 'memory.layer.user',
  project: 'memory.layer.project',
  session: 'memory.layer.session',
};

export const isHuman = (source: string): boolean => source === 'human';

/** Trusted (written by you) or untrusted (a model's, or of unknown origin): icon and word. */
export function TrustBadge({ source }: { source: string }) {
  const human = isHuman(source);
  return (
    <span className={`badge ${human ? 'tone-ok' : 'tone-warn'}`}>
      <span aria-hidden="true">{human ? '✓' : '⚠'}</span>
      {t(human ? 'memory.trusted' : 'memory.untrusted')}
    </span>
  );
}

/** A fact's text as quoted data: whitespace kept, never interpreted. */
export function Quoted({ text, label }: { text: string; label?: string }) {
  return (
    <blockquote className="quoted" aria-label={label}>
      <pre>{text}</pre>
    </blockquote>
  );
}

/** The fact a `memory` confirmation asks about, as the dialog shows it. */
export function MemoryFact(props: {
  m: { layer: MemoryLayer; text: string; source: string; evidence: string[]; localOnly: boolean };
}) {
  const { m } = props;
  return (
    <section aria-labelledby="memory-fact-title" className="memory-fact">
      <h3 id="memory-fact-title" className="sub">
        {t('memory.proposedFor', { layer: t(LAYER_TEXT[m.layer]) })}
      </h3>
      <Quoted text={m.text} label={t('memory.factText')} />
      <dl className="kv small">
        <dt>{t('memory.source')}</dt>
        <dd>
          <span className="mono">{m.source}</span> <TrustBadge source={m.source} />
        </dd>
        <dt>{t('memory.evidence')}</dt>
        <dd className="mono">{m.evidence.join(', ') || '—'}</dd>
        <dt>{t('memory.localOnly')}</dt>
        <dd>{t(m.localOnly ? 'memory.yes' : 'memory.no')}</dd>
      </dl>
      {!isHuman(m.source) && <p className="warn-text small">{t('memory.modelNote')}</p>}
    </section>
  );
}
