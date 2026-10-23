/**
 * What a plan carries besides its nodes (phase 4): the memory every node gets (ADR-0027:
 * counts and sources, never the text), the published estimate accuracy (R-402) and, for a
 * fork, what reruns and what is reused from the parent run (R-403).
 */
import { t } from '../i18n/core';
import { patch } from '../store/store';
import { memoryLines } from '../store/summaries';
import type { MemorySummary, PlanView } from '../store/types';

const TONE = { info: undefined, muted: 'muted', warn: 'warn-text' } as const;

/** The memory line of the plan bar: counts, truncation, local-only, distrust, proposals. */
export function MemoryLine({ m }: { m: MemorySummary }) {
  const lines = memoryLines(m);
  return (
    <div className="small memory-line">
      {lines.map((l, i) => (
        <p key={i} className={TONE[l.tone]}>
          <span aria-hidden="true">{i === 0 ? '◈ ' : l.tone === 'warn' ? '⚠ ' : ''}</span>
          {l.text}
        </p>
      ))}
      {m.pending > 0 && (
        <p>
          <button type="button" className="link" onClick={() => patch({ tab: 'memory' })}>
            {t('plan.memoryOpen')}
          </button>
        </p>
      )}
    </div>
  );
}

/** R-402: how past estimates here compared with billed costs (the kernel's sentence). */
export function AccuracyNote({ note }: { note: string | undefined }) {
  if (!note) return null;
  return (
    <p className="small muted">
      <span aria-hidden="true">≈ </span>
      {t('plan.accuracy', { note })}{' '}
      <button type="button" className="link" onClick={() => patch({ tab: 'evidence' })}>
        {t('plan.accuracyOpen')}
      </button>
    </p>
  );
}

/** R-403: a fork reruns the chosen node and what follows; finished upstream work is reused. */
export function ForkLine({ plan }: { plan: PlanView }) {
  const f = plan.fork;
  if (!f) return null;
  const ids = (list: string[]) => list.map((id) => `#${id}`).join(', ') || '—';
  return (
    <div className="small fork-line">
      <p>
        <strong>{t('fork.title', { run: f.parent.runId.slice(0, 8), id: f.parent.nodeId })}</strong>
      </p>
      <p>{t('fork.rerun', { nodes: ids(f.rerun) })}</p>
      <p className="muted">{t('fork.reused', { nodes: ids(f.reused) })}</p>
      {f.edits.length > 0 && <p>{t('fork.edits', { edits: f.edits.join(' · ') })}</p>}
    </div>
  );
}
