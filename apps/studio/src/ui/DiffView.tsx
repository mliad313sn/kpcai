import { t } from '../i18n/core';
import { applyPatches } from '../store/actions';
import { useStudio } from '../store/store';
import type { Patch } from '../store/types';
import { activeRun } from './view';

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-file';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return '';
}

/**
 * The patch exactly as received. Lines keep their own `+`/`-` markers (meaning is never
 * carried by colour alone); colour only reinforces them. Rendered as text, never as HTML.
 */
export function PatchText({ patch }: { patch: string }) {
  return (
    <pre className="diff" tabIndex={0}>
      {patch.split('\n').map((line, i) => (
        <span key={i} className={`diff-line ${lineClass(line)}`}>
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

function PatchCard(props: { runId: string; p: Patch; applied: boolean }) {
  const { p, runId, applied } = props;
  return (
    <article className="patch" aria-labelledby={`patch-${p.nodeId}`}>
      <div className="row">
        <h3 id={`patch-${p.nodeId}`}>
          <span className="mono">#{p.nodeId}</span> · {t('diff.files', { count: p.files.length })}
        </h3>
        <button
          type="button"
          className="primary"
          disabled={applied}
          onClick={() => void applyPatches(runId, [p.nodeId])}
        >
          {applied ? t('diff.applied') : t('diff.apply')}
        </button>
      </div>
      {p.files.length > 0 && (
        <ul className="files mono small">
          {p.files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      <PatchText patch={p.patch} />
    </article>
  );
}

export function DiffView() {
  const run = useStudio(activeRun);
  if (!run || run.patches.length === 0) return <p className="muted empty">{t('diff.empty')}</p>;
  const pending = run.patches.filter((p) => !run.applied.includes(p.nodeId));
  return (
    <div className="diffs">
      <div className="row">
        <p>{t('diff.summary', { count: run.patches.length })}</p>
        {pending.length > 1 && (
          <button
            type="button"
            onClick={() =>
              void applyPatches(
                run.runId,
                pending.map((p) => p.nodeId),
              )
            }
          >
            {t('diff.applyAll', { count: pending.length })}
          </button>
        )}
      </div>
      {run.patches.map((p) => (
        <PatchCard
          key={p.nodeId}
          runId={run.runId}
          p={p}
          applied={run.applied.includes(p.nodeId)}
        />
      ))}
    </div>
  );
}
