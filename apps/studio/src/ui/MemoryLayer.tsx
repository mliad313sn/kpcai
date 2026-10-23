/**
 * One memory layer in the editor (ADR-0027): its facts with provenance, edit and remove,
 * and a form to add a fact. Every fact is shown as quoted text; nothing is interpreted.
 */
import { useState } from 'react';
import { t } from '../i18n/core';
import { addFact, chooseSession, editFact, memorySession, removeFact } from '../store/memory';
import { useStudio } from '../store/store';
import type { Fact, MemoryLayer } from '../store/types';
import { LAYER_TEXT, Quoted, TrustBadge } from './MemoryFact';

/** Source, date, evidence, local-only, confirmation and edit dates of a fact. */
export function Provenance({ p }: { p: Fact['provenance'] }) {
  return (
    <p className="small muted provenance">
      <TrustBadge source={p.source} /> {t('memory.from', { source: p.source, date: p.date })}
      {p.evidence.length > 0
        ? ` · ${t('memory.evidenceList', { evidence: p.evidence.join(', ') })}`
        : ''}
      {p.localOnly ? ` · ${t('memory.localOnlyTag')}` : ''}
      {p.confirmed ? ` · ${t('memory.confirmedOn', { date: p.confirmed })}` : ''}
      {p.edited ? ` · ${t('memory.editedOn', { date: p.edited })}` : ''}
    </p>
  );
}

function EditForm(props: { layer: MemoryLayer; fact: Fact; done: () => void }) {
  const { layer, fact, done } = props;
  const [text, setText] = useState(fact.text);
  const [localOnly, setLocalOnly] = useState(fact.provenance.localOnly);
  const id = `edit-${fact.id}`;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const edit = {
      ...(text.trim() !== fact.text ? { text: text.trim() } : {}),
      ...(localOnly !== fact.provenance.localOnly ? { localOnly } : {}),
    };
    if (Object.keys(edit).length === 0 || (await editFact(layer, fact.id, edit))) done();
  };
  return (
    <form className="fact-edit" onSubmit={(e) => void save(e)}>
      <label htmlFor={id}>{t('memory.editLabel')}</label>
      <input
        id={id}
        type="text"
        maxLength={1000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      <label className="check">
        <input
          type="checkbox"
          checked={localOnly}
          onChange={(e) => setLocalOnly(e.target.checked)}
        />{' '}
        {t('memory.localOnlyLabel')}
      </label>
      <div className="row">
        <button type="submit" className="primary" disabled={!text.trim()}>
          {t('memory.save')}
        </button>
        <button type="button" onClick={done}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

function FactRow({ layer, fact }: { layer: MemoryLayer; fact: Fact }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'remove'>('view');
  if (mode === 'edit') return <EditForm layer={layer} fact={fact} done={() => setMode('view')} />;
  return (
    <>
      <Quoted text={fact.text} label={t('memory.factText')} />
      <Provenance p={fact.provenance} />
      <div className="row">
        {mode === 'remove' ? (
          <>
            <span className="warn-text small">{t('memory.removeAsk')}</span>
            <button
              type="button"
              className="danger"
              onClick={() => void removeFact(layer, fact.id)}
            >
              {t('memory.removeYes')}
            </button>
            <button type="button" onClick={() => setMode('view')}>
              {t('common.cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setMode('edit')}>
              {t('memory.edit')}
            </button>
            <button type="button" onClick={() => setMode('remove')}>
              {t('memory.remove')}
            </button>
          </>
        )}
      </div>
    </>
  );
}

function AddForm({ layer }: { layer: MemoryLayer }) {
  const [text, setText] = useState('');
  const [localOnly, setLocalOnly] = useState(false);
  const id = `add-${layer}`;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim() && (await addFact(layer, text.trim(), localOnly))) {
      setText('');
      setLocalOnly(false);
    }
  };
  return (
    <form className="fact-add" onSubmit={(e) => void submit(e)}>
      <label htmlFor={id}>{t('memory.addLabel', { layer: t(LAYER_TEXT[layer]) })}</label>
      <div className="row">
        <input
          id={id}
          type="text"
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={!text.trim()}>
          {t('memory.add')}
        </button>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={localOnly}
          onChange={(e) => setLocalOnly(e.target.checked)}
        />{' '}
        {t('memory.localOnlyLabel')}
      </label>
    </form>
  );
}

function SessionPicker() {
  const sessions = useStudio((s) => s.sessions);
  const current = useStudio(() => memorySession());
  if (sessions.length === 0) return <p className="muted small">{t('memory.noSession')}</p>;
  return (
    <p className="row small">
      <label htmlFor="memory-session-pick">{t('memory.session')}</label>
      <select
        id="memory-session-pick"
        value={current ?? ''}
        onChange={(e) => void chooseSession(e.target.value)}
      >
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title || s.id}
          </option>
        ))}
      </select>
    </p>
  );
}

export function LayerSection({ layer }: { layer: MemoryLayer }) {
  const view = useStudio((s) => s.memory.layers[layer]);
  const heading = `memory-${layer}`;
  return (
    <section aria-labelledby={heading} className="memory-layer">
      <h3 id={heading}>{t('memory.layerTitle', { layer: t(LAYER_TEXT[layer]) })}</h3>
      <p className="muted small">{t(`memory.help.${layer}`)}</p>
      {layer === 'session' && <SessionPicker />}
      {view && <p className="muted small mono">{t('memory.file', { file: view.file })}</p>}
      {view && view.facts.length === 0 && <p className="muted">{t('memory.noFacts')}</p>}
      {view && view.facts.length > 0 && (
        <ul className="facts">
          {view.facts.map((f) => (
            <li key={f.id}>
              <FactRow layer={layer} fact={f} />
            </li>
          ))}
        </ul>
      )}
      {view?.problems.map((p, i) => (
        <p key={i} className="warn-text small">
          {t('memory.problem', { line: p.line, message: p.message })}
        </p>
      ))}
      {(layer !== 'session' || view) && <AddForm layer={layer} />}
    </section>
  );
}
