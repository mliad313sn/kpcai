import { useState } from 'react';
import { t } from '../i18n/core';
import { announce, useStudio } from '../store/store';
import type { Artifact } from '../store/types';
import { saveArtifacts } from '../store/workspace';
import { hasArtifacts, hasMethod } from './capabilities';
import { OutputText } from './Conversation';
import { PatchText } from './DiffView';
import { Modal } from './Modal';
import { activeRun } from './view';

const NO_ARTIFACTS: Artifact[] = [];

/** Notebook cells as text (never run, never rendered as HTML); other JSON stays raw. */
function notebookCells(text: string): Array<{ type: string; source: string }> | undefined {
  try {
    const nb = JSON.parse(text) as { cells?: Array<{ cell_type?: unknown; source?: unknown }> };
    if (!Array.isArray(nb.cells)) return undefined;
    return nb.cells.map((c) => ({
      type: typeof c.cell_type === 'string' ? c.cell_type : '?',
      source: Array.isArray(c.source) ? c.source.join('') : String(c.source ?? ''),
    }));
  } catch {
    return undefined;
  }
}

/** The view by deliverable kind: diff, notebook cells, or plain text (WI-S6-01). */
export function ArtifactBody({ a }: { a: Artifact }) {
  if (a.kind === 'patch') return <PatchText patch={a.text} />;
  const cells = a.kind === 'notebook' ? notebookCells(a.text) : undefined;
  if (cells)
    return (
      <ol className="cells">
        {cells.map((c, i) => (
          <li key={i}>
            <p className="meta">{t('artifacts.cell', { n: i + 1, type: c.type })}</p>
            <OutputText text={c.source} />
          </li>
        ))}
      </ol>
    );
  if (!a.text) return <p className="muted">{t('artifacts.noText')}</p>;
  return <OutputText text={a.text} label={a.path} />;
}

function download(a: Artifact): void {
  const url = URL.createObjectURL(new Blob([a.text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = a.path.split(/[\\/]/).pop() || 'artifact.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Saving is always confirmed; the default answer is No. */
function SaveConfirm({ a, close }: { a: Artifact; close: () => void }) {
  return (
    <Modal labelledBy="save-title" describedBy="save-q" onClose={close} initialFocus=".save-no">
      <h2 id="save-title">{t('artifacts.saveTitle')}</h2>
      <p id="save-q">{t('artifacts.saveQuestion', { path: a.path })}</p>
      <div className="row end">
        <button type="button" className="save-no" onClick={close}>
          {t('confirm.no')}
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => {
            close();
            download(a);
            announce(t('artifacts.saved', { path: a.path }));
          }}
        >
          {t('artifacts.saveYes')}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Save: the kernel writes it into the workspace after its own confirmation, which shows
 * the exact content (`artifacts.apply`); without that method, a confirmed local download.
 */
function ArtifactCard({ a, i, runId }: { a: Artifact; i: number; runId: string }) {
  const [saving, setSaving] = useState(false);
  const saved = useStudio((s) => s.savedArtifacts.includes(a.path));
  const save = () =>
    hasMethod('artifacts.apply') ? void saveArtifacts(runId, [a.path]) : setSaving(true);
  return (
    <article className="artifact" aria-labelledby={`artifact-${i}`}>
      <div className="row">
        <h3 id={`artifact-${i}`} className="mono">
          {a.path}
        </h3>
        <span className="tag">{a.kind}</span>
        {a.reviewed === false && (
          <span className="tag warn-text">
            <span aria-hidden="true">⚠ </span>
            {t('artifacts.unreviewed')}
          </span>
        )}
        <span className="spacer" />
        <button type="button" disabled={saved} onClick={save}>
          {saved ? t('artifacts.savedButton') : t('artifacts.save')}
        </button>
      </div>
      {(a.nodeId || a.provenance.length > 0) && (
        <ul className="small muted provenance" aria-label={t('artifacts.provenance')}>
          {a.nodeId && <li>{t('artifacts.fromNode', { id: a.nodeId })}</li>}
          {a.provenance.map((p, k) => (
            <li key={k}>{p}</li>
          ))}
        </ul>
      )}
      <ArtifactBody a={a} />
      {saving && <SaveConfirm a={a} close={() => setSaving(false)} />}
    </article>
  );
}

/** Non-code deliverables of the active run: reports, documents, configs, notebooks, data. */
export function ArtifactsView() {
  const artifacts = useStudio((s) => activeRun(s)?.artifacts ?? NO_ARTIFACTS);
  const runId = useStudio((s) => s.activeRunId ?? '');
  if (artifacts.length === 0)
    return (
      <p className="muted empty">
        {t(hasArtifacts() ? 'artifacts.empty' : 'artifacts.unsupported')}
      </p>
    );
  return (
    <div className="artifacts">
      {artifacts.map((a, i) => (
        <ArtifactCard key={`${a.path} ${i}`} a={a} i={i} runId={runId} />
      ))}
    </div>
  );
}
