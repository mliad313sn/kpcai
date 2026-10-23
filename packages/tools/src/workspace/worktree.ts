import { existsSync } from 'node:fs';
import { mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { gitApplyTool } from '../builtins/git-apply.js';
import { excludePathspecs, filterDiff } from '../builtins/git-filter.js';
import { ToolError } from '../types.js';
import {
  checkRunId,
  gitOut,
  kpaiHome,
  repoHash,
  repoInfo,
  zonesOf,
  type RepoInfo,
  type WorkspaceOptions,
} from './common.js';
import { authorize, MERGE_DEF, type Gate } from './gate.js';
import { commitTree, snapshotTree } from './snapshot.js';
import { treeEntries, writeChanges } from './writer.js';

/**
 * R-307: one git worktree per run under `$KPAI_HOME/worktrees/<repo-hash>/<runId>`,
 * started from HEAD plus the workspace's uncommitted changes (a raw checkpoint,
 * written byte for byte). The run's jail root is the worktree. Its diff is taken
 * against a normalized base snapshot so `git apply` on the user's tree sees the
 * same normal form; merging back is explicit, permission-checked and never commits.
 */
export const RUN_NS = 'refs/kpai/runs';

export interface RunWorktree {
  runId: string;
  /** Worktree top level (real path). */
  path: string;
  /** The run's jail root: the worktree, at the same subdirectory as the workspace root. */
  root: string;
  /** Raw checkpoint the worktree was written from (`refs/kpai/runs/<id>/checkpoint`). */
  checkpoint: string;
  /** Normalized snapshot diffs are taken against (`refs/kpai/runs/<id>/base`). */
  base: string;
}

export interface RunDiff {
  /** Unified diff relative to the workspace root, forbidden zones removed. */
  diff: string;
  files: string[];
  /** Diff sections dropped by the zone filter (defence in depth). */
  omitted: number;
}

function runRef(runId: string, name: 'base' | 'checkpoint'): string {
  return `${RUN_NS}/${runId}/${name}`;
}

async function worktreeDir(opts: WorkspaceOptions, info: RepoInfo, runId: string): Promise<string> {
  return path.join(kpaiHome(opts), 'worktrees', repoHash(info), checkRunId(runId));
}

/** Writes the raw checkpoint into a fresh `--no-checkout` worktree (no hooks, no filters, exact bytes). */
async function populate(opts: WorkspaceOptions, root: string, dir: string, commit: string) {
  await gitOut(opts, root, ['worktree', 'add', '--detach', '--no-checkout', dir, commit]);
  const top = await realpath(dir);
  await gitOut(opts, top, ['read-tree', commit]);
  await writeChanges(opts, top, await treeEntries(opts, top, commit), () => false);
  return top;
}

/** Creates the run's worktree; fails if the run id is already in use for this repository. */
export async function createRunWorktree(
  root: string,
  runId: string,
  opts: WorkspaceOptions = {},
): Promise<RunWorktree> {
  const info = await repoInfo(opts, root);
  const dir = await worktreeDir(opts, info, runId);
  if (existsSync(dir)) throw new ToolError(`run worktree already exists: ${runId}`);
  const tree = await snapshotTree(opts, root, info, true);
  const checkpoint = await commitTree(opts, root, tree, info.head, `kpai run ${runId}: start`);
  await gitOut(opts, root, ['update-ref', runRef(runId, 'checkpoint'), checkpoint, '']).catch(
    () => {
      throw new ToolError(`run id already used in this repository: ${runId}`);
    },
  );
  try {
    await mkdir(path.dirname(dir), { recursive: true });
    const top = await populate(opts, root, dir, checkpoint);
    const runRoot = path.join(top, ...info.prefix.split('/').filter((s) => s !== ''));
    const normal = await snapshotTree(opts, runRoot, await repoInfo(opts, runRoot), false);
    const base = await commitTree(opts, runRoot, normal, checkpoint, `kpai run ${runId}: base`);
    await gitOut(opts, root, ['update-ref', runRef(runId, 'base'), base]);
    return { runId, path: top, root: runRoot, checkpoint, base };
  } catch (err) {
    await removeRunWorktree(root, runId, opts).catch(() => undefined);
    throw err;
  }
}

/** The run's worktree and jail root, which must exist. */
export async function locateRunWorktree(
  root: string,
  runId: string,
  opts: WorkspaceOptions = {},
): Promise<{ info: RepoInfo; path: string; root: string }> {
  const info = await repoInfo(opts, root);
  const dir = await worktreeDir(opts, info, runId);
  if (!existsSync(path.join(dir, '.git'))) throw new ToolError(`no worktree for run ${runId}`);
  const top = await realpath(dir);
  return { info, path: top, root: path.join(top, ...info.prefix.split('/').filter(Boolean)) };
}

const OMITTED_NOTE = /\[(\d+) entr(?:y|ies) in forbidden zones omitted\]\n$/;

/** The run's changes since it started, relative to the workspace root, zone-filtered. */
export async function diffRunWorktree(
  root: string,
  runId: string,
  opts: WorkspaceOptions = {},
): Promise<RunDiff> {
  const wt = await locateRunWorktree(root, runId, opts);
  const base = (
    await gitOut(opts, wt.root, ['rev-parse', '--verify', '-q', runRef(runId, 'base')])
  ).trim();
  const current = await snapshotTree(opts, wt.root, await repoInfo(opts, wt.root), false);
  const zones = zonesOf(opts);
  const binary = opts.git?.apply?.allowBinary === true ? ['--binary'] : [];
  const args = ['diff-tree', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const raw = await gitOut(opts, wt.root, [
    ...args,
    ...binary,
    '--relative',
    base,
    current,
    '--',
    '.',
    ...excludePathspecs(zones),
  ]);
  const filtered = filterDiff(raw, zones);
  const note = OMITTED_NOTE.exec(filtered);
  const diff = note ? filtered.slice(0, note.index) : filtered;
  const files = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((m) => m[2] as string);
  return { diff, files, omitted: note ? Number(note[1]) : 0 };
}

export interface MergeResult {
  applied: boolean;
  files: string[];
  omitted: number;
}

/**
 * Applies the run's diff to the workspace through the git.apply checks (jail,
 * zones, binary / executable / symlink rules, `--check`). A write: the policy
 * decides and the human confirms. Never stages or commits.
 */
export async function mergeBack(
  root: string,
  runId: string,
  gate: Gate,
  opts: WorkspaceOptions = {},
): Promise<MergeResult> {
  const d = await diffRunWorktree(root, runId, opts);
  if (d.diff.trim() === '') return { applied: false, files: [], omitted: d.omitted };
  const tool = gitApplyTool({ ...opts.git, zones: zonesOf(opts) });
  const ctx = { ...gate.ctx, root, signal: opts.signal ?? gate.ctx.signal };
  const input = { patch: d.diff };
  const prepared = await (tool.prepare as NonNullable<typeof tool.prepare>)(input, ctx);
  const summary = `merge run ${runId}: ${prepared.summary}\n${prepared.preview ?? ''}`;
  await authorize(gate, root, MERGE_DEF, { runId, ...input }, summary);
  const r = await tool.run(input, ctx);
  if (r.isError) throw new ToolError(r.content);
  return { applied: true, files: d.files, omitted: d.omitted };
}

/** Removes the run's worktree and its run refs (checkpoints are kept). */
export async function removeRunWorktree(
  root: string,
  runId: string,
  opts: WorkspaceOptions = {},
): Promise<{ removed: boolean }> {
  const info = await repoInfo(opts, root);
  const dir = await worktreeDir(opts, info, runId);
  const had = existsSync(dir);
  if (had) {
    await gitOut(opts, root, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
  await gitOut(opts, root, ['worktree', 'prune']);
  for (const name of ['base', 'checkpoint'] as const) {
    await gitOut(opts, root, ['update-ref', '-d', runRef(runId, name)]).catch(() => undefined);
  }
  return { removed: had };
}
