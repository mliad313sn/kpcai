/**
 * P5-F4, P5-R2 (D-035): a test run is evidence only when the run did not change what the
 * test command runs. In a git root (a run's worktree starts from a checkpoint commit, R-307)
 * every change since HEAD is the run's own. The run is `tampered` when it changed:
 *  - a test, package-manager or toolchain configuration (control-files.ts), a package.json
 *    `scripts` / `jest` / detected runner, or a lockfile entry of a runner package;
 *  - a file on the runner side (tamper-refs.ts: what the command, the test scripts and the
 *    configurations name, followed transitively), or any executable file;
 *  - the same among git-ignored files it wrote (tamper-ignored.ts).
 * A run that wrote under the runner's resolution path (`node_modules`, a venv) is
 * `unverified`: the tests ran, but which runner ran them is not known. Either way the
 * result is no test evidence. Test files and the code under test may change freely.
 * Reads git and files only; ADR-0032 (P5-R2 addendum) lists what this cannot see.
 */
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isLockfilePath, isTestConfigPath } from '../control-files.js';
import type { Env } from '../env.js';
import { failed, gitRun, type GitCtx } from './git-exec.js';
import { ignoredChanges } from './tamper-ignored.js';
import { runnerSide, type RunnerSide } from './tamper-refs.js';
import type { TestCommand } from './test-detect.js';

export interface TamperCheck {
  /** False when the root is no git repository (nothing to compare with). */
  checked: boolean;
  /** Files the run changed that decide how its tests run (relative to the root), sorted. */
  files: string[];
  /** What makes the runner unverified: files written where it resolves from, or limits hit. */
  unverified: string[];
}

const MAX_FILES = 20;
const LIST_MAX = 64 * 1024 * 1024;
const TOO_LONG = '(change list too long to check)';

/** Lockfile lines naming a test runner or a package it is built from. */
const RUNNER_PKG =
  /(?:^|[^\w-])(?:@(?:vitest|jest|playwright)\/[\w.-]+|(?:vitest|jest|pytest|mocha|ava|tap|tape|jasmine|karma|playwright|uvu|c8|nyc|tsx|ts-node|ts-jest|babel-jest|esbuild-register|pluggy|chai|expect|tinypool)(?:-[\w.-]+)?)(?=[^\w-]|$)/i;

interface Scan {
  changed: string[];
  configs: string[];
  ignored: string[];
  sinceMs: number;
  truncated: boolean;
}

type Git = (args: string[]) => Promise<{ out: string; truncated: boolean }>;

function gitOf(env: Env | undefined, ctx: GitCtx): Git {
  return async (args) => {
    const r = await gitRun({ env }, ctx, args, { maxOutputBytes: LIST_MAX });
    if (failed(r)) throw new Error('git');
    return { out: r.stdout, truncated: r.truncated };
  };
}

const nul = (s: string): string[] => s.split('\0').filter((p) => p !== '');

/** Changed, configuration and ignored files under the root, relative to it; HEAD's time. */
async function scan(g: Git): Promise<Scan | undefined> {
  try {
    const diff = await g(['diff', '--name-only', '-z', '--no-renames', '--relative', 'HEAD', '--']);
    const added = await g(['ls-files', '-z', '--others', '--exclude-standard']);
    const all = await g(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    const ign = ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'];
    const ignored = await g(ign);
    const time = await g(['log', '-1', '--format=%ct', 'HEAD']);
    const lists = [diff, added, all, ignored];
    return {
      changed: [...new Set([...nul(diff.out), ...nul(added.out)])].sort(),
      configs: nul(all.out).filter(isTestConfigPath),
      ignored: nul(ignored.out),
      sinceMs: Number(time.out.trim()) * 1000,
      truncated: lists.some((l) => l.truncated),
    };
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

async function headText(g: Git, rel: string): Promise<string | undefined> {
  return g(['show', `HEAD:./${rel}`]).then(
    (r) => r.out,
    () => undefined,
  );
}

/** The `scripts`, `jest` and detected runner of a package.json changed (or it is new). */
async function packageChanged(g: Git, root: string, rel: string): Promise<boolean> {
  const now = await readFile(path.join(root, rel), 'utf8').catch(() => undefined);
  const before = await headText(g, rel);
  return JSON.stringify(packageFacts(now)) !== JSON.stringify(packageFacts(before));
}

const indent = (l: string): number => /^\s*/.exec(l)?.[0].length ?? 0;

/**
 * The lines of a lockfile about runner packages: each line naming one, with the lines
 * indented under it (a package-lock entry, a yarn.lock or pnpm-lock block).
 */
function runnerBlocks(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!RUNNER_PKG.test(line)) continue;
    const at = indent(line);
    out.push(line);
    while (i + 1 < lines.length && indent(lines[i + 1] as string) > at)
      out.push(lines[++i] as string);
  }
  return out.join('\n');
}

/** A lockfile is new, deleted or binary, or changed what it resolves a runner package to. */
async function lockfileChanged(g: Git, root: string, rel: string): Promise<boolean> {
  if (/\.lockb$/i.test(rel)) return true;
  const before = await headText(g, rel);
  const now = await readFile(path.join(root, rel), 'utf8').catch(() => undefined);
  if (before === undefined || now === undefined) return true;
  return runnerBlocks(before) !== runnerBlocks(now);
}

async function executable(abs: string): Promise<boolean> {
  const st = await lstat(abs).catch(() => undefined);
  return st !== undefined && st.isFile() && (st.mode & 0o111) !== 0;
}

async function isTampered(g: Git, root: string, rel: string, side: RunnerSide): Promise<boolean> {
  const name = path.posix.basename(rel).toLowerCase();
  if (name === 'package.json') return packageChanged(g, root, rel);
  if (isLockfilePath(rel)) return lockfileChanged(g, root, rel);
  if (isTestConfigPath(rel) || side.files.has(rel) || side.missing.has(rel)) return true;
  return executable(path.join(root, rel));
}

/** What this run changed of what its tests run (empty when nothing, or no git). */
export async function testConfigTamper(
  root: string,
  cmd: TestCommand | undefined,
  opts: { env?: Env; signal?: AbortSignal } = {},
): Promise<TamperCheck> {
  const ctx: GitCtx = { root, ...(opts.signal ? { signal: opts.signal } : {}) };
  const g = gitOf(opts.env, ctx);
  const s = await scan(g);
  if (!s) return { checked: false, files: [], unverified: [] };
  const side = await runnerSide(root, cmd, s.configs);
  const files = new Set<string>();
  for (const rel of s.changed) {
    if (files.size >= MAX_FILES) break;
    if (await isTampered(g, root, rel, side)) files.add(rel);
  }
  const ign = await ignoredChanges({
    root,
    entries: s.ignored,
    sinceMs: s.sinceMs,
    runnerSide: side.files,
  });
  for (const f of ign.files) files.add(f);
  const unverified = [
    ...ign.unverified,
    ...(s.truncated ? [TOO_LONG] : []),
    ...(side.overflow ? ['(runner side too large to check)'] : []),
  ];
  return { checked: true, files: [...files].sort().slice(0, MAX_FILES), unverified };
}

/** Journal meta for a test run (packages/learning counts neither kind as evidence). */
export function tamperMeta(t: TamperCheck): Record<string, unknown> {
  if (t.files.length === 0 && t.unverified.length === 0) return { tampered: false };
  return {
    tampered: true,
    tamperedFiles: [...t.files, ...t.unverified].slice(0, MAX_FILES),
    ...(t.unverified.length ? { runnerUnverified: true } : {}),
  };
}

/** Evidence line entries: changed files, then what left the runner unverified. */
export function tamperEntries(t: TamperCheck): string[] {
  return [...t.files, ...t.unverified.map((u) => `${u} (runner unverified)`)];
}

/** The confirmation suffix for a tampered or unverified test run (P5-F4, P5-R2), or ''. */
export function tamperNote(t: TamperCheck): string {
  const parts: string[] = [];
  if (t.files.length > 0) {
    const shown = t.files.slice(0, 5).join(', ');
    parts.push(`; TAMPERED: this run changed its own test configuration (${shown})`);
  }
  if (t.unverified.length > 0) {
    const shown = t.unverified.slice(0, 5).join(', ');
    parts.push(
      `; RUNNER UNVERIFIED: this run wrote where the test runner loads from (${shown}): tests ran, runner unverified`,
    );
  }
  if (parts.length === 0) return '';
  return `${parts.join('')}, so the result will not count as test evidence`;
}
