/**
 * P5-R2: git-ignored files the run wrote. Git does not see them, but a runner loads them:
 * `npx vitest` runs `node_modules/.bin/vitest`, `python -m pytest` imports from a venv, a
 * git-ignored `.npmrc` picks npm's shell. "The run wrote it" is a change time (ctime, which
 * a process cannot set back) at or after the HEAD commit the run started from.
 *  - Anything new under a resolution directory (`node_modules`, `.venv`, `venv`,
 *    `__pypackages__`) except the runner's own result cache: the runner the command reaches
 *    cannot be verified (`unverified`), whatever the file is.
 *  - A new ignored file elsewhere that is a test configuration, executable, or on the
 *    runner side: `tampered`, as for a tracked one.
 * Other wholly ignored directories (build output, caches the tests write) are not walked:
 * only runner-side files inside them are checked.
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isTestConfigPath } from '../control-files.js';

export interface IgnoredFinding {
  /** Ignored test configuration, executable or runner-side files the run wrote. */
  files: string[];
  /** Files the run wrote where the runner resolves from: the runner is unverified. */
  unverified: string[];
}

const RESOLUTION_DIRS = new Set(['node_modules', '.venv', 'venv', '__pypackages__']);
/** Result caches the runner itself writes on every run (vitest's test order and timings). */
const RUNNER_CACHES = [
  /(?:^|\/)node_modules\/\.vite\/vitest\//,
  /(?:^|\/)node_modules\/\.vitest\//,
];
/** Files looked at under resolution directories, all of them together. */
export const MAX_WALK = 100_000;
const MAX_REPORT = 5;

export interface IgnoredInput {
  root: string;
  /** `git ls-files --others --ignored --exclude-standard --directory` (directories end in `/`). */
  entries: readonly string[];
  /** HEAD's commit time (ms): a file changed at or after it is the run's. */
  sinceMs: number;
  /** Runner-side files (tamper-refs.ts), relative to the root. */
  runnerSide: ReadonlySet<string>;
}

async function changedSince(abs: string, sinceMs: number): Promise<boolean> {
  const st = await lstat(abs).catch(() => undefined);
  return st !== undefined && !st.isDirectory() && st.ctimeMs >= sinceMs;
}

async function executable(abs: string): Promise<boolean> {
  const st = await lstat(abs).catch(() => undefined);
  return st !== undefined && (st.isSymbolicLink() || (st.isFile() && (st.mode & 0o111) !== 0));
}

class Budget {
  seen = 0;
  out: string[] = [];
  over = false;
  get done(): boolean {
    return this.over || this.out.length >= MAX_REPORT;
  }
}

/** New files under a resolution directory (no symlinks followed; directories skipped). */
async function walk(root: string, rel: string, sinceMs: number, b: Budget): Promise<void> {
  const stack = [rel];
  while (stack.length > 0 && !b.done) {
    const dir = stack.pop() as string;
    const st = await lstat(path.join(root, dir)).catch(() => undefined);
    if (!st) continue;
    if (!st.isDirectory()) {
      if (st.ctimeMs >= sinceMs && !RUNNER_CACHES.some((re) => re.test(dir))) b.out.push(dir);
      continue;
    }
    const names = await readdir(path.join(root, dir)).catch(() => [] as string[]);
    if ((b.seen += names.length) > MAX_WALK) b.over = true;
    for (const n of names.sort().reverse()) stack.push(`${dir}/${n}`);
  }
}

function underResolutionDir(rel: string): boolean {
  return rel.split('/').some((s) => RESOLUTION_DIRS.has(s));
}

/** An individually ignored file the run wrote that decides how tests run. */
async function ignoredFile(i: IgnoredInput, rel: string): Promise<boolean> {
  const abs = path.join(i.root, rel);
  if (!(await changedSince(abs, i.sinceMs))) return false;
  return isTestConfigPath(rel) || i.runnerSide.has(rel) || (await executable(abs));
}

/** What the run wrote among the root's ignored files (see the module comment). */
export async function ignoredChanges(i: IgnoredInput): Promise<IgnoredFinding> {
  const files: string[] = [];
  const b = new Budget();
  for (const e of i.entries) {
    const rel = e.replace(/\/$/, '');
    if (underResolutionDir(rel)) {
      if (!b.done) await walk(i.root, rel, i.sinceMs, b);
    } else if (e.endsWith('/')) {
      for (const s of i.runnerSide)
        if (s.startsWith(`${rel}/`) && (await changedSince(path.join(i.root, s), i.sinceMs)))
          files.push(s);
    } else if (await ignoredFile(i, rel)) files.push(rel);
  }
  const unverified = b.over ? [...b.out, `${MAX_WALK}+ ignored files (not all checked)`] : b.out;
  return { files, unverified };
}
