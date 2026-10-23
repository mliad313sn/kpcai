import type { Kernel, RunOutcome } from '@kernelpai/kernel';
import type { Io } from '../io.js';

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
