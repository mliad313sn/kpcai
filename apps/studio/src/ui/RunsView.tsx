import { useEffect, useState } from 'react';
import { t } from '../i18n/core';
import { formatUsd } from '../store/format';
import { patch, useStudio } from '../store/store';
import type { RunSummary, RunView } from '../store/types';
import {
  discardRun,
  loadCheckpoints,
  loadRuns,
  mergeRun,
  restoreCheckpoint,
} from '../store/workspace';
import { hasMethod, RUN_MANAGER_METHODS } from './capabilities';
import { StateBadge } from './StateBadge';

/** A local run (this window's events) as a runs-manager row, for kernels without runs.list. */
function localRow(r: RunView): RunSummary {
  const judged = Object.values(r.nodes).filter((n) => n.approved !== undefined);
  return {
    runId: r.runId,
    planId: '',
    sessionId: '',
    request: r.request,
    state: r.state,
    startedAt: new Date(r.startedAt).toISOString(),
    costUsd: r.costUsd,
    isolated: r.worktree !== undefined,
    ...(r.worktree ? { worktree: r.worktree } : {}),
    ...(judged.length
      ? { verdict: judged.every((n) => n.approved) ? 'approved' : 'changes_requested' }
      : {}),
    patches: r.patches.length,
    artifacts: r.artifacts.length,
  };
}

function Pending() {
  const missing = RUN_MANAGER_METHODS.filter((m) => !hasMethod(m));
  if (missing.length === 0) return null;
  return (
    <p className="muted small" role="note">
      {t('runs.pending', { methods: missing.join(', ') })}
    </p>
  );
}

function Checkpoints({ runId }: { runId: string }) {
  const list = useStudio((s) => s.checkpoints[runId]);
  if (!list) return <p className="muted small">{t('runs.loading')}</p>;
  if (list.length === 0) return <p className="muted small">{t('runs.noCheckpoints')}</p>;
  return (
    <ol className="checkpoints" aria-label={t('runs.checkpoints')}>
      {list.map((c) => (
        <li key={c.ref} className="row">
          <span>
            {t('runs.checkpoint', { n: c.n, label: c.label, where: c.where, at: c.createdAt })}
          </span>
          <button type="button" onClick={() => void restoreCheckpoint(runId, c.ref)}>
            {t('runs.restore')}
          </button>
        </li>
      ))}
    </ol>
  );
}

function diffText(r: RunSummary): string {
  if (r.diff)
    return t('runs.diffStats', {
      files: r.diff.files,
      add: r.diff.additions,
      del: r.diff.deletions,
    });
  return t('runs.patchCount', { count: r.patches, artifacts: r.artifacts });
}

function Row({ r, open, toggle }: { r: RunSummary; open: boolean; toggle: () => void }) {
  const active = useStudio((s) => s.activeRunId === r.runId);
  const known = useStudio((s) => s.runs[r.runId] !== undefined);
  return (
    <tr aria-current={active ? 'true' : undefined}>
      <th scope="row">
        {known ? (
          <button
            type="button"
            className="link"
            onClick={() => patch({ activeRunId: r.runId, tab: 'conversation' })}
          >
            {r.request || r.runId}
          </button>
        ) : (
          r.request || r.runId
        )}
      </th>
      <td>
        <StateBadge state={r.state} />
      </td>
      <td className="num">{formatUsd(r.costUsd)}</td>
      <td>{diffText(r)}</td>
      <td>{r.verdict ? t(`runs.verdict.${r.verdict}`) : '—'}</td>
      <td className="mono small">{r.worktree ?? t('runs.inPlace')}</td>
      <td>
        <RowActions r={r} open={open} toggle={toggle} />
      </td>
    </tr>
  );
}

function RowActions({ r, open, toggle }: { r: RunSummary; open: boolean; toggle: () => void }) {
  const finished = ['done', 'failed', 'cancelled'].includes(r.state);
  return (
    <span className="row">
      {hasMethod('run.checkpoints') && (
        <button type="button" aria-expanded={open} onClick={toggle}>
          {t('runs.checkpoints')}
        </button>
      )}
      {r.worktree && finished && hasMethod('run.merge') && (
        <button type="button" className="primary" onClick={() => void mergeRun(r.runId)}>
          {t('runs.merge')}
        </button>
      )}
      {r.worktree && finished && hasMethod('run.discard') && (
        <button type="button" className="danger" onClick={() => void discardRun(r.runId)}>
          {t('runs.discard')}
        </button>
      )}
    </span>
  );
}

function useRows(): RunSummary[] {
  const server = useStudio((s) => s.serverRuns);
  const local = useStudio((s) => s.runs);
  const ids = new Set(server.map((r) => r.runId));
  const rows = [
    ...server,
    ...Object.values(local)
      .filter((r) => !ids.has(r.runId))
      .map(localRow),
  ];
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** R-307 runs manager: run, state, cost, diff, critic verdict; checkpoints (R-305), merge. */
export function RunsView() {
  const conn = useStudio((s) => s.conn);
  const rows = useRows();
  const [open, setOpen] = useState<string | undefined>();
  useEffect(() => {
    if (conn === 'open' && hasMethod('runs.list')) void loadRuns();
  }, [conn]);
  const toggle = (runId: string) => {
    setOpen(open === runId ? undefined : runId);
    if (open !== runId) void loadCheckpoints(runId);
  };
  return (
    <div className="runs-view">
      <Pending />
      {hasMethod('runs.list') && (
        <button type="button" disabled={conn !== 'open'} onClick={() => void loadRuns()}>
          {t('runs.refresh')}
        </button>
      )}
      {rows.length === 0 ? (
        <p className="muted empty">{t('runs.empty')}</p>
      ) : (
        <table className="runs">
          <caption className="sr-only">{t('runs.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('runs.run')}</th>
              <th scope="col">{t('runs.state')}</th>
              <th scope="col">{t('runs.cost')}</th>
              <th scope="col">{t('runs.diff')}</th>
              <th scope="col">{t('runs.critics')}</th>
              <th scope="col">{t('runs.worktree')}</th>
              <th scope="col">{t('runs.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.runId} r={r} open={open === r.runId} toggle={() => toggle(r.runId)} />
            ))}
          </tbody>
        </table>
      )}
      {open && <Checkpoints runId={open} />}
    </div>
  );
}
