/**
 * P5-F4 (D-035): a test run is evidence only when the run did not change what the test
 * command runs. In a git root (a run's worktree starts from a checkpoint commit, R-307)
 * every change since HEAD is the run's own: a changed package.json `scripts` (or the
 * runner it detects), `.kpstudio/test.json`, a vitest / jest / pytest configuration, or a
 * script file the test command names makes the run `tampered`. Reads git and files only.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isTestConfigPath } from '../control-files.js';
import type { Env } from '../env.js';
import { failed, git, type GitCtx } from './git-exec.js';
import type { TestCommand } from './test-detect.js';

export interface TamperCheck {
  /** False when the root is no git repository (nothing to compare with). */
  checked: boolean;
  /** Test configuration files the run changed (relative to the root), sorted. */
  files: string[];
}

const MAX_FILES = 20;

async function gitList(env: Env | undefined, ctx: GitCtx, args: string[]): Promise<string[]> {
  const r = await git({ env }, ctx, args);
  if (failed(r)) throw new Error('git');
  return r.stdout.split('\0').filter((p) => p !== '');
}

/** Files changed or added since HEAD under the root, relative to it. */
async function changedFiles(env: Env | undefined, ctx: GitCtx): Promise<string[] | undefined> {
  try {
    const diff = ['diff', '--name-only', '-z', '--no-renames', '--relative', 'HEAD', '--'];
    const tracked = await gitList(env, ctx, diff);
    const added = await gitList(env, ctx, ['ls-files', '-z', '--others', '--exclude-standard']);
    return [...new Set([...tracked, ...added])];
  } catch {
    return undefined;
  }
}

interface PackageFacts {
  scripts?: unknown;
  jest?: unknown;
  runner: string[];
}

function packageFacts(text: string | undefined): PackageFacts | 'unreadable' | undefined {
  if (text === undefined) return undefined;
  try {
    const p = JSON.parse(text) as Record<string, unknown>;
    const deps = { ...(p.dependencies as object), ...(p.devDependencies as object) };
    const runner = ['vitest', 'jest'].filter((d) => d in deps);
    return { scripts: p.scripts, jest: p.jest, runner };
  } catch {
    return 'unreadable';
  }
}

/** The `scripts`, `jest` and detected runner of a package.json changed (or it is new). */
async function packageChanged(env: Env | undefined, ctx: GitCtx, rel: string): Promise<boolean> {
  const now = await readFile(path.join(ctx.root, rel), 'utf8').catch(() => undefined);
  const r = await git({ env }, ctx, ['show', `HEAD:./${rel}`]);
  const before = failed(r) ? undefined : r.stdout;
  return JSON.stringify(packageFacts(now)) !== JSON.stringify(packageFacts(before));
}

const PATHISH = /[\\/]|\.(?:[cm]?[jt]s|sh|py|mjs|bash|ps1|rb|pl)$/i;

/** Script files the test command or the root package.json scripts name (`node scripts/t.js`). */
async function scriptRefs(root: string, cmd: TestCommand | undefined): Promise<Set<string>> {
  const words: string[] = [...(cmd ? [cmd.command, ...cmd.args] : [])];
  const pkg = packageFacts(
    await readFile(path.join(root, 'package.json'), 'utf8').catch(() => undefined),
  );
  if (pkg && pkg !== 'unreadable' && pkg.scripts && typeof pkg.scripts === 'object') {
    for (const s of Object.values(pkg.scripts as Record<string, unknown>))
      if (typeof s === 'string') words.push(...s.split(/[\s;&|()<>"'`=]+/));
  }
  const refs = new Set<string>();
  for (const w of words) {
    if (!PATHISH.test(w) || path.isAbsolute(w)) continue;
    refs.add(path.posix.normalize(w.replace(/\\/g, '/')).replace(/^\.\//, ''));
  }
  return refs;
}

async function isTampered(
  env: Env | undefined,
  ctx: GitCtx,
  rel: string,
  refs: Set<string>,
): Promise<boolean> {
  if (path.posix.basename(rel).toLowerCase() === 'package.json')
    return packageChanged(env, ctx, rel);
  return isTestConfigPath(rel) || refs.has(rel);
}

/** What this run changed of its own test configuration (empty when nothing, or no git). */
export async function testConfigTamper(
  root: string,
  cmd: TestCommand | undefined,
  opts: { env?: Env; signal?: AbortSignal } = {},
): Promise<TamperCheck> {
  const ctx: GitCtx = { root, ...(opts.signal ? { signal: opts.signal } : {}) };
  const changed = await changedFiles(opts.env, ctx);
  if (!changed) return { checked: false, files: [] };
  const refs = await scriptRefs(root, cmd);
  const files: string[] = [];
  for (const rel of changed.sort()) {
    if (files.length >= MAX_FILES) break;
    if (await isTampered(opts.env, ctx, rel, refs)) files.push(rel);
  }
  return { checked: true, files };
}

/** The confirmation suffix for a tampered test run (P5-F4), or ''. */
export function tamperNote(t: TamperCheck): string {
  if (t.files.length === 0) return '';
  const shown = t.files.slice(0, 5).join(', ');
  return `; TAMPERED: this run changed its own test configuration (${shown}), so the result will not count as test evidence`;
}
