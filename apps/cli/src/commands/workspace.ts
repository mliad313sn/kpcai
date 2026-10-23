/**
 * `kpai checkpoints`, `restore`, `merge`, `discard` (R-305, R-307, ADR-0021). They work
 * from git and the journal, so they also reach runs of an earlier `kpai do` or a console
 * that has stopped. Restore and merge are confirmed at the prompt and journaled.
 */
import { Kernel, KernelError, type CheckpointInfo } from '@kernelpai/kernel';
import { kernelHost } from '../host.js';
import type { Io } from '../io.js';
import { sanitizeForTerminal } from '../sanitize.js';

async function withKernel(io: Io, db: string | undefined, f: (k: Kernel) => Promise<number>) {
  const kernel = new Kernel(kernelHost(io, db ? { db } : {}));
  try {
    return await f(kernel);
  } catch (err) {
    if (!(err instanceof KernelError)) throw err;
    io.err(`${err.message}\n`);
    return err.code === 'invalid' ? 2 : 1;
  } finally {
    await kernel.close();
  }
}

function line(c: CheckpointInfo): string {
  const where = c.where === 'worktree' ? 'worktree ' : 'workspace';
  return `  ${c.ref}  ${c.createdAt}  ${where}  ${sanitizeForTerminal(c.label)}\n`;
}

/** Run ids whose checkpoints were journaled in a session. */
function runsOfSession(k: Kernel, session: string): string[] {
  const ids = k
    .events(session, 100_000)
    .filter((e) => e.type === 'intervention')
    .map((e) => e.payload as { action?: string; runId?: string })
    .filter((p) => p.action === 'checkpoint' && typeof p.runId === 'string')
    .map((p) => p.runId as string);
  return [...new Set(ids)];
}

/** `kpai checkpoints [--session <id>]`: checkpoints by run, oldest first. */
export function checkpointsCommand(io: Io, o: { db?: string; session?: string }): Promise<number> {
  return withKernel(io, o.db, async (k) => {
    const runs = o.session ? runsOfSession(k, o.session) : await k.workspace.runsWithCheckpoints();
    let count = 0;
    for (const runId of runs) {
      const list = await k.checkpoints(runId);
      if (list.length === 0) continue;
      io.out(`run ${runId}\n${list.map(line).join('')}`);
      count += list.length;
    }
    if (count === 0) io.out('no checkpoint\n');
    else io.out(`restore one with: kpai restore <ref>\n`);
    return 0;
  });
}

/** `kpai restore <ref>`: destructive, always asked (never `--yes`). */
export function restoreCommand(io: Io, o: { db?: string; ref: string }): Promise<number> {
  return withKernel(io, o.db, async (k) => {
    const r = await k.restore(o.ref);
    if (!r.restored) {
      io.err(`not restored — ${r.reason}\n`);
      return 1;
    }
    io.out(
      `restored ${o.ref}: ${r.written.length} written, ${r.deleted.length} deleted` +
        `${r.skipped ? `, ${r.skipped} in forbidden zones untouched` : ''}\nundo: kpai restore ${r.undo}\n`,
    );
    return 0;
  });
}

/** `kpai merge <runId>`: the run's worktree diff into the workspace, confirmed with the diff. */
export function mergeCommand(io: Io, o: { db?: string; runId: string }): Promise<number> {
  return withKernel(io, o.db, async (k) => {
    const d = await k.workspace.diff(o.runId);
    if (d) io.err(`--- merge of run ${o.runId}\n${d.diff}`);
    const m = await k.merge(o.runId);
    if (!m.merged) {
      io.err(`not merged — ${m.reason}\n`);
      return m.reason === 'nothing to merge' ? 0 : 1;
    }
    io.out(`merged ${m.files.length} file(s): ${m.files.join(', ')}\n`);
    if (m.checkpoint) io.out(`undo: kpai restore ${m.checkpoint}\n`);
    io.out(`remove the worktree with: kpai discard ${o.runId}\n`);
    return 0;
  });
}

/** `kpai discard <runId>`: removes the run's worktree (its checkpoints stay). */
export function discardCommand(io: Io, o: { db?: string; runId: string }): Promise<number> {
  return withKernel(io, o.db, async (k) => {
    const r = await k.discard(o.runId);
    io.out(r.removed ? `worktree of run ${o.runId} removed\n` : `no worktree for run ${o.runId}\n`);
    return 0;
  });
}
