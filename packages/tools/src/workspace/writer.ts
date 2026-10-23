import { chmod, lstat, mkdir, realpath, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitOut, gctx, PLUMBING_MAX_OUTPUT, type WorkspaceOptions } from './common.js';
import { gitRun, failed } from '../builtins/git-exec.js';
import { touchesGitDir } from '../paths.js';
import { ToolError } from '../types.js';
import type { TreeChange } from './snapshot.js';

const BLOB_BATCH = 500;

/** Raw blob contents by id (`cat-file --batch`, binary-safe, in batches). */
export async function readBlobs(
  opts: WorkspaceOptions,
  top: string,
  shas: readonly string[],
): Promise<Map<string, Buffer>> {
  const unique = [...new Set(shas)];
  const out = new Map<string, Buffer>();
  for (let i = 0; i < unique.length; i += BLOB_BATCH) {
    const chunk = unique.slice(i, i + BLOB_BATCH);
    const r = await gitRun(opts.git ?? {}, gctx(top, opts), ['cat-file', '--batch'], {
      stdin: chunk.join('\n') + '\n',
      binary: true,
      maxOutputBytes: PLUMBING_MAX_OUTPUT * 4,
    });
    if (failed(r) || r.truncated || !r.stdoutBytes) throw new ToolError('git cat-file failed');
    parseBatch(r.stdoutBytes, out);
  }
  for (const s of unique) if (!out.has(s)) throw new ToolError(`missing object ${s}`);
  return out;
}

function parseBatch(buf: Buffer, out: Map<string, Buffer>): void {
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(buf.subarray(pos, nl).toString('latin1'));
    if (!m) throw new ToolError('unexpected object in checkpoint');
    const size = Number(m[2]);
    out.set(m[1] as string, Buffer.from(buf.subarray(nl + 1, nl + 1 + size)));
    pos = nl + 1 + size + 1;
  }
}

/** Repository paths from our own trees, checked again before touching the disk. */
function checkTreePath(p: string): string[] {
  const segs = p.split('/');
  const bad = segs.some((s) => s === '' || s === '.' || s === '..');
  const winBad = process.platform === 'win32' && /[\\:]/.test(p);
  if (bad || winBad || touchesGitDir(p)) throw new ToolError(`refusing to write path: ${p}`);
  return segs;
}

export interface WriteResult {
  written: string[];
  deleted: string[];
  /** Paths left alone because they are in a forbidden zone (count only, never named). */
  skipped: number;
}

/** Creates the parent directories of `segs` under top; never follows or replaces a non-directory. */
async function ensureParents(top: string, segs: string[]): Promise<void> {
  let cur = top;
  for (const s of segs.slice(0, -1)) {
    cur = path.join(cur, s);
    const st = await lstat(cur).catch(() => undefined);
    if (!st) await mkdir(cur);
    else if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new ToolError(`cannot write ${segs.join('/')}: a parent is not a directory`);
    }
  }
}

/** Removes the file or link at abs (or an empty directory in the way). */
async function clearTarget(abs: string, rel: string): Promise<void> {
  const st = await lstat(abs).catch(() => undefined);
  if (!st) return;
  if (st.isDirectory()) {
    await rmdir(abs).catch(() => {
      throw new ToolError(`cannot write ${rel}: a non-empty directory is in the way`);
    });
  } else await unlink(abs);
}

async function writeEntry(top: string, c: TreeChange, data: Buffer): Promise<void> {
  const segs = checkTreePath(c.path);
  await ensureParents(top, segs);
  const abs = path.join(top, ...segs);
  await clearTarget(abs, c.path);
  if (c.mode === '120000') {
    const target = data.toString('utf8');
    const linked = await symlink(target, abs).then(
      () => true,
      () => false,
    );
    if (!linked) await writeFile(abs, target, { flag: 'wx' }); // core.symlinks=false behaviour
    return;
  }
  const mode = c.mode === '100755' ? 0o755 : 0o644;
  await writeFile(abs, data, { flag: 'wx', mode });
  await chmod(abs, mode);
}

/** True when the parent of `segs` is the real directory it should be (no symlinked parent). */
async function realParent(top: string, segs: string[]): Promise<boolean> {
  const expected = path.join(top, ...segs.slice(0, -1));
  const real = await realpath(expected).catch(() => undefined);
  if (real === undefined) return false;
  return process.platform === 'win32'
    ? real.toLowerCase() === expected.toLowerCase()
    : real === expected;
}

async function deleteEntry(top: string, rel: string): Promise<boolean> {
  const segs = checkTreePath(rel);
  if (!(await realParent(top, segs))) return false;
  const abs = path.join(top, ...segs);
  const st = await lstat(abs).catch(() => undefined);
  if (!st || st.isDirectory()) return false;
  await unlink(abs);
  // Prune directories the deletion left empty, never the top itself.
  for (let n = segs.length - 1; n > 0; n--) {
    const ok = await rmdir(path.join(top, ...segs.slice(0, n))).then(
      () => true,
      () => false,
    );
    if (!ok) break;
  }
  return true;
}

/**
 * Applies tree changes to the working tree under `top`: deletions first, then
 * writes of raw blob bytes with their modes. `skip(path)` marks paths to leave
 * alone (forbidden zones).
 */
export async function writeChanges(
  opts: WorkspaceOptions,
  top: string,
  changes: readonly TreeChange[],
  skip: (repoPath: string) => boolean,
): Promise<WriteResult> {
  const res: WriteResult = { written: [], deleted: [], skipped: 0 };
  const todo = changes.filter((c) => (skip(c.path) ? (res.skipped++, false) : true));
  for (const c of todo.filter((c) => c.sha === undefined)) {
    if (await deleteEntry(top, c.path)) res.deleted.push(c.path);
  }
  const writes = todo.filter((c) => c.sha !== undefined);
  const blobs = await readBlobs(
    opts,
    top,
    writes.map((c) => c.sha as string),
  );
  for (const c of writes) {
    await writeEntry(top, c, blobs.get(c.sha as string) as Buffer);
    res.written.push(c.path);
  }
  return res;
}

/** Every file of a tree as additions (to populate an empty worktree). */
export async function treeEntries(
  opts: WorkspaceOptions,
  top: string,
  treeish: string,
): Promise<TreeChange[]> {
  const out = await gitOut(opts, top, ['ls-tree', '-r', '-z', '--full-tree', treeish]);
  const entries: TreeChange[] = [];
  for (const line of out.split('\0')) {
    const m = /^(\d{6}) blob ([0-9a-f]+)\t(.+)$/s.exec(line);
    if (m) entries.push({ mode: m[1] as string, sha: m[2] as string, path: m[3] as string });
  }
  return entries;
}
