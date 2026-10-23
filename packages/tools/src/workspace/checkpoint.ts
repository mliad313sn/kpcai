import { ToolError } from '../types.js';
import {
  checkRunId,
  cleanLabel,
  gitOut,
  inZone,
  repoInfo,
  zonesOf,
  type RepoInfo,
  type WorkspaceOptions,
} from './common.js';
import { authorize, RESTORE_DEF, type Gate } from './gate.js';
import { commitTree, snapshotTree, treeChanges, type TreeChange } from './snapshot.js';
import { writeChanges, type WriteResult } from './writer.js';

/**
 * R-305 checkpoints: a raw snapshot of the workspace (tracked and untracked
 * files, .gitignore respected) committed off-branch and pointed to by
 * `refs/kpai/checkpoints/<run>/<n>`. Built on a temporary index; the user's
 * index, HEAD, branches and stash are never touched. Forbidden-zone files are
 * snapshotted (objects stay in the local repository) but no API here returns
 * file contents, and restore never writes or deletes them.
 */
export const CHECKPOINT_NS = 'refs/kpai/checkpoints';
const MESSAGE_PREFIX = 'kpai checkpoint: ';
const REF_RE = /^refs\/kpai\/checkpoints\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/([1-9]\d{0,8})$/;

export interface Checkpoint {
  ref: string;
  run: string;
  n: number;
  commit: string;
  label: string;
  /** ISO 8601 commit date. */
  createdAt: string;
}

export interface CheckpointOptions extends WorkspaceOptions {
  /** Run id: the checkpoint goes under `refs/kpai/checkpoints/<run>/`. */
  run: string;
}

/** Snapshots the workspace into the next `refs/kpai/checkpoints/<run>/<n>`. */
export async function checkpoint(
  root: string,
  label: string,
  opts: CheckpointOptions,
): Promise<Checkpoint> {
  const run = checkRunId(opts.run);
  const info = await repoInfo(opts, root);
  const tree = await snapshotTree(opts, root, info, true);
  const text = cleanLabel(label);
  const commit = await commitTree(opts, root, tree, info.head, `${MESSAGE_PREFIX}${text}`);
  for (let attempt = 0; attempt < 5; attempt++) {
    const n = Math.max(0, ...(await listCheckpoints(root, run, opts)).map((c) => c.n)) + 1;
    const ref = `${CHECKPOINT_NS}/${run}/${n}`;
    // Empty old value: create only if absent, so two writers never share an <n>.
    const made = await gitOut(opts, root, ['update-ref', ref, commit, '']).then(
      () => true,
      () => false,
    );
    if (made) return { ref, run, n, commit, label: text, createdAt: new Date().toISOString() };
  }
  throw new ToolError(`could not allocate a checkpoint number for run ${run}`);
}

/** The checkpoints of a run, oldest first. */
export async function listCheckpoints(
  root: string,
  run: string,
  opts: WorkspaceOptions = {},
): Promise<Checkpoint[]> {
  checkRunId(run);
  const fmt = '--format=%(refname)%00%(objectname)%00%(subject)%00%(creatordate:iso-strict)';
  const out = await gitOut(opts, root, ['for-each-ref', fmt, `${CHECKPOINT_NS}/${run}/`]);
  const list: Checkpoint[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [ref = '', commit = '', subject = '', date = ''] = line.split('\0');
    const m = REF_RE.exec(ref);
    if (!m || m[1] !== run) continue;
    const label = subject.startsWith(MESSAGE_PREFIX)
      ? subject.slice(MESSAGE_PREFIX.length)
      : subject;
    list.push({ ref, run, n: Number(m[2]), commit, label, createdAt: date });
  }
  return list.sort((a, b) => a.n - b.n);
}

/** The commit a checkpoint ref points to; refuses anything but our namespace. */
export async function resolveCheckpoint(
  root: string,
  ref: string,
  opts: WorkspaceOptions = {},
): Promise<string> {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) {
    throw new ToolError(`not a checkpoint ref: ${String(ref)}`);
  }
  const out = await gitOut(opts, root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).catch(
    () => '',
  );
  if (out.trim() === '') throw new ToolError(`checkpoint not found: ${ref}`);
  return out.trim();
}

export interface RestoreResult extends WriteResult {
  ref: string;
  /** Checkpoint of the tree as it was just before this restore (to undo it). */
  undo: string;
}

/** Root-relative form of a repository path (for zone matching and messages). */
function relToRoot(info: RepoInfo, p: string): string {
  return p.startsWith(info.prefix) ? p.slice(info.prefix.length) : p;
}

async function restorePlan(
  opts: WorkspaceOptions,
  root: string,
  commit: string,
): Promise<{ info: RepoInfo; changes: TreeChange[] }> {
  const info = await repoInfo(opts, root);
  const current = await snapshotTree(opts, root, info, true);
  return { info, changes: await treeChanges(opts, root, current, `${commit}^{tree}`) };
}

function describePlan(ref: string, info: RepoInfo, visible: TreeChange[], skipped: number): string {
  const del = visible.filter((c) => c.sha === undefined).length;
  const lines = visible
    .slice(0, 20)
    .map((c) => `${c.sha ? 'write ' : 'delete'} ${relToRoot(info, c.path)}`);
  if (visible.length > 20) lines.push(`… (${visible.length - 20} more)`);
  const zone = skipped > 0 ? `; ${skipped} in forbidden zones left untouched` : '';
  return [
    `restore ${ref}: ${visible.length - del} file(s) written, ${del} deleted${zone}`,
    ...lines,
  ].join('\n');
}

/** Identity of a restore plan: every path with the mode and blob it would get. */
function planKey(changes: readonly TreeChange[]): string {
  return changes
    .map((c) => `${c.path}\0${c.mode ?? ''}\0${c.sha ?? ''}`)
    .sort()
    .join('\n');
}

/**
 * Puts the working tree under root back to the checkpoint: changed files are
 * rewritten with their exact bytes and modes, files created since are removed
 * (ignored files are never touched, forbidden zones neither). Destructive: goes
 * through the permission policy and the human's confirmation every time.
 */
export async function restore(
  root: string,
  ref: string,
  gate: Gate,
  opts: WorkspaceOptions = {},
): Promise<RestoreResult> {
  const commit = await resolveCheckpoint(root, ref, opts);
  const zones = zonesOf(opts);
  const plan = await restorePlan(opts, root, commit);
  const skip = (p: string): boolean => inZone(relToRoot(plan.info, p), zones);
  const visible = plan.changes.filter((c) => !skip(c.path));
  const paths = visible.map((c) => relToRoot(plan.info, c.path));
  const summary = describePlan(ref, plan.info, visible, plan.changes.length - visible.length);
  await authorize(gate, root, RESTORE_DEF, { ref, paths }, summary);
  // Safety net first: a restore that stops halfway (or is regretted) can be undone.
  const run = (REF_RE.exec(ref) as RegExpExecArray)[1] as string;
  const undo = await checkpoint(root, `before restore of ${ref}`, { ...opts, run });
  // The human approved exactly `visible`. If the tree changed while they were reading,
  // the fresh plan differs: write nothing and ask again (review P3-F7).
  const fresh = await restorePlan(opts, root, commit);
  const freshVisible = fresh.changes.filter((c) => !inZone(relToRoot(fresh.info, c.path), zones));
  if (planKey(freshVisible) !== planKey(visible)) {
    throw new ToolError(
      'the tree changed while you were answering: nothing was restored, ask again',
    );
  }
  const res = await writeChanges(opts, fresh.info.top, fresh.changes, (p) =>
    inZone(relToRoot(fresh.info, p), zones),
  );
  const rel = (list: string[]) => list.map((p) => relToRoot(fresh.info, p));
  return {
    ref,
    undo: undo.ref,
    written: rel(res.written),
    deleted: rel(res.deleted),
    skipped: res.skipped,
  };
}
