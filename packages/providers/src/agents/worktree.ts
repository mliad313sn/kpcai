/**
 * The node's worktree (R-503): a private checkout of the workspace's HEAD in a fresh temp
 * "jail" directory, where an agent CLI works. It is a `--shared` clone, not a linked git
 * worktree, so the agent never touches the workspace's own `.git` (config, hooks). After
 * the run the change is read back as a diff, which then follows the normal approval path.
 *
 * Every git command here runs with the agent's scrubbed environment and with fsmonitor and
 * hooks off: the checkout's config was writable by the agent, so these commands must not
 * gain anything the agent did not already have.
 */
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Largest diff an agent may hand back. */
export const MAX_DIFF_BYTES = 512 * 1024;
/** Directory names inside the jail that belong to the run (anything else is an escape). */
const JAIL_OWN = new Set(['wt', 'tmp']);
const NO_HOOKS = process.platform === 'win32' ? 'NUL' : '/dev/null';
const SAFE = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NO_HOOKS}`];

export interface NodeWorktree {
  /** The workspace the checkout comes from (its top level). */
  root: string;
  /** The temp directory holding the checkout (`wt`) and the agent's TMPDIR (`tmp`). */
  jail: string;
  /** Where the agent runs. */
  path: string;
  /** The commit the checkout starts from; diffs are taken against it. */
  base: string;
}

export function git(
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  stdin?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...SAFE, ...args],
      { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]}: ${String(stderr).trim() || err.message}`));
        else resolve(String(stdout));
      },
    );
    child.stdin?.on('error', () => undefined);
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}

/** A fresh checkout of `root`'s HEAD in a new jail. Throws when `root` is not a git repo. */
export async function openWorktree(
  root: string,
  env: Record<string, string>,
): Promise<NodeWorktree> {
  const top = (await git(['rev-parse', '--show-toplevel'], root, env)).trim();
  const base = (await git(['rev-parse', 'HEAD'], top, env)).trim();
  const jail = await realpath(await mkdtemp(join(tmpdir(), 'kpai-agent-')));
  const path = join(jail, 'wt');
  try {
    await git(['clone', '--shared', '--no-checkout', '--quiet', top, path], jail, env);
    await git(['checkout', '--quiet', '--detach', base], path, env);
    await mkdir(join(jail, 'tmp'));
  } catch (err) {
    await rm(jail, { recursive: true, force: true });
    throw err;
  }
  return { root: top, jail, path, base };
}

/** Applies an earlier draft (a revision continues from it). */
export async function applyDraft(
  wt: NodeWorktree,
  diff: string,
  env: Record<string, string>,
): Promise<void> {
  if (diff.trim() === '') return;
  await git(['apply', '--whitespace=nowarn', '-'], wt.path, env, diff);
}

/** Everything the agent changed in its checkout since `base`, as one unified diff. */
export async function worktreeDiff(wt: NodeWorktree, env: Record<string, string>): Promise<string> {
  await git(['add', '-A'], wt.path, env);
  const args = ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];
  return git([...args, wt.base], wt.path, env);
}

export async function closeWorktree(wt: NodeWorktree): Promise<void> {
  await rm(wt.jail, { recursive: true, force: true, maxRetries: 3 });
}

/** Files a diff touches (both sides of each `diff --git` header). */
export function diffFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
    files.add(m[1] as string);
    files.add(m[2] as string);
  }
  return [...files];
}

/**
 * Why a diff cannot be handed on, or undefined: links (a symlink can point anywhere),
 * submodules, binary content, paths that leave the tree or reach `.git`, or a diff too big
 * to review.
 */
export function diffProblem(diff: string): string | undefined {
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) return `diff larger than ${MAX_DIFF_BYTES} bytes`;
  if (/^(new file mode|deleted file mode|old mode|new mode) 120000/m.test(diff))
    return 'diff creates or changes a symbolic link';
  if (/^(new file mode|deleted file mode|old mode|new mode|index \S+) 160000/m.test(diff))
    return 'diff touches a submodule';
  if (/^(GIT binary patch|Binary files )/m.test(diff)) return 'diff has binary content';
  if (/^diff --git "/m.test(diff)) return 'diff has a quoted (unusual) file name';
  const bad = diffFiles(diff).find(
    (f) => isAbsolute(f) || f.split('/').some((s) => s === '..' || s === '.git'),
  );
  return bad ? `diff path leaves the worktree: ${bad}` : undefined;
}

/** Fingerprint of what an escape could change: the workspace and the jail around `wt`. */
export type Snapshot = Map<string, string>;

async function stamp(path: string): Promise<string> {
  try {
    const s = await lstat(path);
    return `${s.mode}:${s.size}:${s.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * The workspace's changed and untracked files, its top-level entries (ignored files such
 * as `.env` included), its git config and hooks, and the jail's own entries.
 */
export async function snapshot(wt: NodeWorktree, env: Record<string, string>): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  const status = await git(['status', '--porcelain=v1', '-z', '-uall'], wt.root, env);
  snap.set('status', status);
  const paths = status
    .split('\0')
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3));
  const common = (await git(['rev-parse', '--git-common-dir'], wt.root, env)).trim();
  const gitDir = isAbsolute(common) ? common : join(wt.root, common);
  const watch = [
    ...paths.map((p) => join(wt.root, p)),
    // `.git` itself changes on every index refresh; its config and hooks are watched below.
    ...(await entries(wt.root)).filter((e) => e !== '.git').map((e) => join(wt.root, e)),
    join(gitDir, 'config'),
    ...(await entries(join(gitDir, 'hooks'))).map((e) => join(gitDir, 'hooks', e)),
  ];
  for (const p of watch) snap.set(p, await stamp(p));
  for (const e of await entries(wt.jail)) {
    if (!JAIL_OWN.has(e)) snap.set(join(wt.jail, e), await stamp(join(wt.jail, e)));
  }
  return snap;
}

/** What changed between two snapshots (paths, `status` for the git status itself). */
export function changedSince(before: Snapshot, after: Snapshot): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort();
}
