import { useState } from 'react';
import { t } from '../i18n/core';
import { instructNode, loadModels, redirectNode } from '../store/actions';
import { refKey } from '../store/reducer';
import { announce, useStudio } from '../store/store';

/** Principle 4: move a node to another model; finished work is kept. */
export function Redirect({ runId, nodeId }: { runId: string; nodeId: string }) {
  const models = useStudio((s) => s.models);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const [provider, ...rest] = value.split('/');
    const model = rest.join('/');
    if (!provider || !model) return;
    void redirectNode(runId, nodeId, { provider, model });
    setOpen(false);
  };
  if (!open)
    return (
      <button type="button" onClick={() => (setOpen(true), void loadModels())}>
        {t('steer.redirectTo')}
      </button>
    );
  return (
    <form className="row" onSubmit={submit} aria-label={t('steer.redirectForm')}>
      <label htmlFor="redirect-model">{t('edit.model')}</label>
      <input
        id="redirect-model"
        list="redirect-models"
        placeholder="provider/model"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <datalist id="redirect-models">
        {models.map((m) => (
          <option key={refKey(m)} value={refKey(m)} />
        ))}
      </datalist>
      <button type="submit" className="primary" disabled={!/^[^/]+\/.+/.test(value)}>
        {t('steer.redirect')}
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        {t('common.close')}
      </button>
    </form>
  );
}

/** R-304: an instruction added to a node that has not started; it joins the node's prompt. */
export function InstructBox({ runId, nodeId }: { runId: string; nodeId: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const instruction = text.trim();
    if (!instruction) return;
    setBusy(true);
    if (await instructNode(runId, nodeId, instruction)) {
      setText('');
      announce(t('steer.sent', { id: nodeId }));
    }
    setBusy(false);
  };
  return (
    <form className="instruct" onSubmit={(e) => void submit(e)} aria-labelledby="instruct-title">
      <h4 id="instruct-title">{t('steer.instructTitle')}</h4>
      <label htmlFor="instruct-text" className="muted small">
        {t('steer.instructHelp')}
      </label>
      <textarea
        id="instruct-text"
        rows={3}
        maxLength={10_000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(e);
        }}
      />
      <button type="submit" disabled={busy || !text.trim()}>
        {busy ? t('steer.sending') : t('steer.instruct')}
      </button>
    </form>
  );
}
