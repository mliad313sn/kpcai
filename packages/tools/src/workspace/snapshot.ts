import { lstat, mkdtemp, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolError } from '../types.js';
import { gitOut, KPAI_IDENT, type RepoInfo, type WorkspaceOptions } from './common.js';

/**
 * Workspace snapshots as git trees, built on a temporary index (GIT_INDEX_FILE in
 * a fresh temp dir) so the user's index, HEAD, branches and stash are never touched.
 *
 * - `raw`: exact bytes (`hash-object --no-filters`), used by checkpoints so a
 *   restore puts back the very bytes that were there (CRLF, no eol conversion).
 * - normalized: git's own clean conversion (eol, with filter drivers blanked by
 *   git-exec), used for run diffs so that `git apply` on the user's tree sees the
 *   same normal form it converts files to.
 *
 * Only the workspace root's part of the repository reflects the working tree;
 * the rest of the tree is HEAD's. Symlinks are stored as links (their target
 * text), never followed; a path below a symlinked directory is skipped.
 */
interface Entry {
  path: string;
  mode: string;
  /** Link target (mode 120000) hashed from text instead of from the file. */
  link?: string;
}

function nulList(out: string): string[] {
  return out.split('\0').filter((s) => s !== '');
}

/** Tracked paths (with index mode) and untracked, not-ignored paths under the root. */
async function listPaths(opts: WorkspaceOptions, root: string): Promise<Map<string, string>> {
  const cached = await gitOut(opts, root, ['ls-files', '-s', '-z', '--full-name', '--', '.']);
  const others = await gitOut(opts, root, [
    'ls-files',
    '-o',
    '-z',
    '--exclude-standard',
    '--full-name',
    '--',
    '.',
  ]);
  const paths = new Map<string, string>();
  for (const line of nulList(cached)) {
    const m = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/s.exec(line);
    if (m && m[1] !== '160000') paths.set(m[2] as string, m[1] as string);
  }
  // A trailing `/` is a nested repository: never descended (no submodules).
  for (const p of nulList(others)) if (!p.endsWith('/') && !paths.has(p)) paths.set(p, '');
  return paths;
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True when the directory of `rel` is a real directory inside top (no symlinked parent). */
function parentChecker(top: string): (rel: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (rel) => {
    const dir = path.posix.dirname(rel);
    if (dir === '.') return Promise.resolve(true);
    let hit = cache.get(dir);
    if (!hit) {
      const expected = path.join(top, ...dir.split('/'));
      hit = realpath(expected).then(
        (real) => samePath(real, expected),
        () => false,
      );
      cache.set(dir, hit);
    }
    return hit;
  };
}

async function classify(top: string, rel: string, indexMode: string): Promise<Entry | undefined> {
  const abs = path.join(top, ...rel.split('/'));
  const st = await lstat(abs).catch(() => undefined);
  if (st?.isSymbolicLink()) return { path: rel, mode: '120000', link: await readlink(abs) };
  if (!st?.isFile()) return undefined;
  if (process.platform === 'win32') {
    // No exec bits or (usually) symlinks on Windows: keep what the index says.
    const mode = indexMode === '100755' || indexMode === '120000' ? indexMode : '100644';
    return { path: rel, mode };
  }
  return { path: rel, mode: (st.mode & 0o111) !== 0 ? '100755' : '100644' };
}

/** Working-tree entries under the root, symlinked parents skipped. */
async function workingEntries(
  opts: WorkspaceOptions,
  root: string,
  info: RepoInfo,
): Promise<Entry[]> {
  const listed = await listPaths(opts, root);
  const parentOk = parentChecker(info.top);
  const entries: Entry[] = [];
  for (const [rel, indexMode] of listed) {
    if (!(await parentOk(rel))) continue;
    const e = await classify(info.top, rel, indexMode);
    if (e) entries.push(e);
  }
  return entries;
}

/** Names `--stdin-paths` would mangle (line breaks, C-quoting, trailing CR). */
function unsafeName(p: string): boolean {
  return p.includes('\n') || p.startsWith('"') || p.endsWith('\r');
}

async function hashEntries(
  opts: WorkspaceOptions,
  info: RepoInfo,
  entries: Entry[],
  raw: boolean,
): Promise<string[]> {
  const base = ['hash-object', '-w', ...(raw ? ['--no-filters'] : [])];
  const at = { cwd: info.top };
  const shas = new Array<string>(entries.length);
  const batch: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as Entry;
    if (e.link !== undefined) {
      shas[i] = (
        await gitOut(opts, info.top, ['hash-object', '-w', '--stdin'], { ...at, stdin: e.link })
      ).trim();
    } else if (unsafeName(e.path)) {
      shas[i] = (await gitOut(opts, info.top, [...base, '--', e.path], at)).trim();
    } else batch.push(i);
  }
  if (batch.length > 0) {
    const stdin = batch.map((i) => (entries[i] as Entry).path).join('\n') + '\n';
    const out = (await gitOut(opts, info.top, [...base, '--stdin-paths'], { ...at, stdin }))
      .split(/\r?\n/)
      .filter((s) => s !== '');
    if (out.length !== batch.length) throw new ToolError('git hash-object returned a short list');
    batch.forEach((i, k) => (shas[i] = out[k] as string));
  }
  return shas;
}

/** Runs `fn` with a fresh temporary index file, removed afterwards. */
async function withTempIndex<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kpai-index-'));
  try {
    return await fn({ GIT_INDEX_FILE: path.join(dir, 'index') });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Snapshot of the root as a tree id (see module doc for raw vs normalized). */
export async function snapshotTree(
  opts: WorkspaceOptions,
  root: string,
  info: RepoInfo,
  raw: boolean,
): Promise<string> {
  const entries = await workingEntries(opts, root, info);
  const shas = await hashEntries(opts, info, entries, raw);
  return withTempIndex(async (env) => {
    const run = (args: string[], stdin?: string) => gitOut(opts, root, args, { env, stdin });
    await run(info.head ? ['read-tree', info.head] : ['read-tree', '--empty']);
    const old = nulList(await run(['ls-files', '-s', '-z', '--full-name', '--', '.']))
      .filter((l) => !l.startsWith('160000 '))
      .map((l) => l.slice(l.indexOf('\t') + 1));
    if (old.length > 0)
      await run(['update-index', '-z', '--force-remove', '--stdin'], old.join('\0') + '\0');
    const lines = entries.map((e, i) => `${e.mode} ${shas[i]}\t${e.path}\0`);
    if (lines.length > 0) await run(['update-index', '-z', '--index-info'], lines.join(''));
    return (await run(['write-tree'])).trim();
  });
}

/** A commit for a snapshot tree (fixed identity, never signed, no hooks). */
export async function commitTree(
  opts: WorkspaceOptions,
  root: string,
  tree: string,
  parent: string | undefined,
  message: string,
): Promise<string> {
  const args = [
    'commit-tree',
    '--no-gpg-sign',
    tree,
    ...(parent ? ['-p', parent] : []),
    '-m',
    message,
  ];
  return (await gitOut(opts, root, args, { env: KPAI_IDENT })).trim();
}

/** Raw `diff-tree` entries between two trees, limited to the root (`.` from cwd). */
export interface TreeChange {
  path: string;
  /** Mode and blob in the target tree; undefined when the path is absent there. */
  mode?: string;
  sha?: string;
}

export async function treeChanges(
  opts: WorkspaceOptions,
  root: string,
  from: string,
  to: string,
): Promise<TreeChange[]> {
  const out = await gitOut(opts, root, [
    'diff-tree',
    '-r',
    '-z',
    '--no-renames',
    '--raw',
    from,
    to,
    '--',
    '.',
  ]);
  const parts = out.split('\0');
  const changes: TreeChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])/.exec(parts[i] as string);
    if (!m) continue;
    const [, oldMode, mode, sha, status] = m as unknown as string[];
    if (oldMode === '160000' || mode === '160000') continue;
    const p = parts[i + 1] as string;
    changes.push(status === 'D' ? { path: p } : { path: p, mode, sha });
  }
  return changes;
}
