/**
 * The memory editor (ADR-0027): user, project and session facts with their provenance,
 * and the queue of facts models proposed. A proposal is stored only when you keep it; a
 * model's fact stays untrusted data in every prompt even then.
 */
import { useEffect } from 'react';
import { t } from '../i18n/core';
import { LAYERS, confirmProposal, loadMemory, rejectProposal } from '../store/memory';
import { useStudio } from '../store/store';
import type { PendingFact } from '../store/types';
import { LayerSection, Provenance } from './MemoryLayer';
import { LAYER_TEXT, Quoted } from './MemoryFact';

function Proposal({ p }: { p: PendingFact }) {
  const id = `proposal-${p.id}`;
  return (
    <li>
      <article aria-labelledby={id} className="proposal">
        <h4 id={id} className="sub">
          {t('memory.proposalFor', { layer: t(LAYER_TEXT[p.scope.layer]) })}
        </h4>
        <Quoted text={p.text} label={t('memory.factText')} />
        <Provenance p={p.provenance} />
        <p className="small muted">{t('memory.proposedAt', { date: p.proposedAt })}</p>
        <div className="row">
          <button type="button" className="primary" onClick={() => void confirmProposal(p.id)}>
            {t('memory.keep')}
          </button>
          <button type="button" className="danger" onClick={() => void rejectProposal(p.id)}>
            {t('memory.reject')}
          </button>
        </div>
      </article>
    </li>
  );
}

function Pending() {
  const pending = useStudio((s) => s.memory.pending);
  return (
    <section aria-labelledby="memory-pending" className="memory-pending">
      <h3 id="memory-pending">{t('memory.pendingTitle', { count: pending.length })}</h3>
      <p className="muted small">{t('memory.pendingHelp')}</p>
      {pending.length === 0 ? (
        <p className="muted">{t('memory.noPending')}</p>
      ) : (
        <ul className="facts">
          {pending.map((p) => (
            <Proposal key={p.id} p={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function MemoryView() {
  const conn = useStudio((s) => s.conn);
  const loading = useStudio((s) => s.memory.loading);
  useEffect(() => {
    if (conn === 'open') void loadMemory();
  }, [conn]);
  return (
    <div className="memory-view">
      <p className="muted small">{t('memory.intro')}</p>
      <button type="button" disabled={conn !== 'open' || loading} onClick={() => void loadMemory()}>
        {loading ? t('runs.loading') : t('memory.refresh')}
      </button>
      <Pending />
      {LAYERS.map((l) => (
        <LayerSection key={l} layer={l} />
      ))}
    </div>
  );
}
