import type { Kernel, RunOutcome } from '@kernelpai/kernel';
import type { Io } from '../io.js';
import { sanitizeForTerminal } from '../sanitize.js';

type Finished = Extract<RunOutcome, { status: 'finished' }>;

/**
 * Shows the run's patches, then applies them with `--apply`. The kernel only hands over
 * patches of code and test nodes **approved** by a critic from another provider (principle
 * 2, review P2-F4) and refuses those carrying control characters (P2-F1, F12). Nothing is
 * applied after a cancel (P2-F6); each write is confirmed unless `--yes-apply` (P2-F15) —
 * `--yes` alone never approves writes.
 */
export async function showAndApply(
  io: Io,
  kernel: Kernel,
  runId: string,
  outcome: Finished,
  o: { apply?: boolean; yesApply?: boolean },
): Promise<string> {
  const { patches, refused } = outcome;
  for (const r of refused) {
    io.err(
      `\n✗ patch from ${r.nodeId} refused: it contains control characters that could hide content\n`,
    );
  }
  if (patches.length === 0) return refused.length ? 'patches refused' : 'no patch';
  for (const p of patches) {
    io.err(`\n--- patch from ${p.nodeId} (${p.files.join(', ') || 'unknown files'})\n`);
    io.err(p.patch);
  }
  if (outcome.cancelled) return `${patches.length} patch(es) shown, not applied (run cancelled)`;
  if (!o.apply) return `${patches.length} patch(es) shown, not applied (use --apply)`;
  const results = await kernel.applyPatches(runId, o.yesApply ? { yesApply: true } : {});
  for (const r of results) io.err(`${r.ok ? '✓' : '✗'} ${r.nodeId}: ${r.message}\n`);
  return `${results.filter((r) => r.ok).length}/${patches.length} patch(es) applied`;
}

/**
 * Shows the run's approved artifacts (D-019), then writes them with `--apply`, each
 * confirmed with its content unless `--yes-apply`. Empty string when there is none.
 */
export async function showAndApplyArtifacts(
  io: Io,
  kernel: Kernel,
  runId: string,
  outcome: Finished,
  o: { apply?: boolean; yesApply?: boolean },
): Promise<string> {
  for (const r of outcome.refusedArtifacts) {
    io.err(`\n✗ artifact ${sanitizeForTerminal(r.path)} from ${r.nodeId} refused: ${r.reason}\n`);
  }
  const list = outcome.artifacts;
  if (list.length === 0) return '';
  for (const a of list) {
    const review = a.reviewed
      ? ''
      : ', NOT REVIEWED: asked on its own, --yes-apply does not cover it';
    io.err(
      `\n--- artifact ${a.path} (${a.kind}, ${a.mime}, ${a.bytes} bytes${review}) from ${a.nodeId}\n`,
    );
    io.err(a.content);
  }
  if (outcome.cancelled || !o.apply) return `${list.length} artifact(s) shown, not written`;
  const results = await kernel.applyArtifacts(runId, o.yesApply ? { yesApply: true } : {});
  for (const r of results) io.err(`${r.ok ? '✓' : '✗'} ${r.path}: ${r.message}\n`);
  return `${results.filter((r) => r.ok).length}/${list.length} artifact(s) written`;
}

/**
 * `--isolated` (R-307): the run worked in its own worktree. With `--apply`, offer to
 * merge it back (confirmed with the whole diff, after a checkpoint) and remove it once
 * merged; otherwise keep it and say how to merge or discard it later.
 */
export async function finishIsolated(
  io: Io,
  kernel: Kernel,
  runId: string,
  outcome: Finished,
  o: { apply?: boolean },
): Promise<string> {
  if (!outcome.worktree) return '';
  const d = await kernel.workspace.diff(runId);
  if (!d || d.diff.trim() === '') {
    await kernel.discard(runId);
    return 'worktree empty, removed';
  }
  if (o.apply && !outcome.cancelled) {
    io.err(`\n--- merge of run ${runId} into the workspace\n${d.diff}`);
    const m = await kernel.merge(runId);
    if (m.merged) {
      await kernel.discard(runId);
      return `merged ${m.files.length} file(s)${m.checkpoint ? ` (undo: kpai restore ${m.checkpoint})` : ''}`;
    }
  }
  io.err(`worktree kept: ${outcome.worktree}\n  kpai merge ${runId}  ·  kpai discard ${runId}\n`);
  return 'worktree kept';
}
