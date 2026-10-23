/**
 * Runs manager, checkpoints and artifacts (R-305, R-307, D-019; ADR-0021, ADR-0022). Every
 * write (restore, merge, artifact) is confirmed by the kernel with a `confirm.request` whose
 * default is No; these calls only ask for it.
 */
import { t } from '../i18n/core';
import { call, fail } from './actions';
import { announce, log, patch, studio } from './store';

export async function loadRuns(): Promise<void> {
  try {
    const { runs } = await call('runs.list', {});
    patch({ serverRuns: runs });
  } catch (e) {
    fail('fail.runs', e);
  }
}

export async function loadCheckpoints(runId: string): Promise<void> {
  try {
    const { checkpoints } = await call('run.checkpoints', { runId });
    patch({ checkpoints: { ...studio.getState().checkpoints, [runId]: checkpoints } });
  } catch (e) {
    fail('fail.checkpoints', e);
  }
}

/** Long timeout: the kernel waits for the user's answer to the restore confirmation. */
const WRITE_TIMEOUT_MS = 180_000;

export async function restoreCheckpoint(runId: string, ref: string): Promise<void> {
  try {
    const r = await call('run.restore', { runId, ref }, WRITE_TIMEOUT_MS);
    announce(
      r.restored
        ? t('workspace.restored', { written: r.written.length, deleted: r.deleted.length })
        : t('workspace.notRestored', { reason: r.reason }),
    );
    await loadCheckpoints(runId);
  } catch (e) {
    fail('fail.restore', e);
  }
}

export async function mergeRun(runId: string): Promise<void> {
  try {
    const r = await call('run.merge', { runId }, WRITE_TIMEOUT_MS);
    announce(
      r.merged
        ? t('workspace.merged', { count: r.files.length })
        : t('workspace.notMerged', { reason: r.reason ?? '' }),
    );
    await loadRuns();
  } catch (e) {
    fail('fail.merge', e);
  }
}

export async function discardRun(runId: string): Promise<void> {
  try {
    const r = await call('run.discard', { runId });
    announce(t(r.removed ? 'workspace.discarded' : 'workspace.notDiscarded'));
    await loadRuns();
  } catch (e) {
    fail('fail.discard', e);
  }
}

/** Writes artifacts of a finished run into the workspace, each confirmed with its content. */
export async function saveArtifacts(runId: string, paths: string[]): Promise<void> {
  try {
    const { results } = await call('artifacts.apply', { runId, paths }, WRITE_TIMEOUT_MS);
    const saved = results.filter((r) => r.ok).map((r) => r.path);
    for (const r of results.filter((x) => !x.ok))
      log('warn', t('workspace.artifactNotSaved', { path: r.path, message: r.message }));
    patch({ savedArtifacts: [...new Set([...studio.getState().savedArtifacts, ...saved])] });
    announce(t('workspace.artifactsSaved', { count: saved.length }));
  } catch (e) {
    fail('fail.artifacts', e);
  }
}
