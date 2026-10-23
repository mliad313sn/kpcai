import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext } from '@kernelpai/core';
import { scrubEnv, type Env } from '../env.js';
import { runProcess, type RunResult } from '../process.js';
import { fail, ok, type ToolOutcome } from '../types.js';

export interface GitApplyRules {
  /** Allow `GIT binary patch` / `Binary files … differ` sections (default false). */
  allowBinary?: boolean;
  /** Allow creating files with, or changing files to, mode 100755 (default false). */
  allowExecutable?: boolean;
  /** Allow symlink modes (120000) (default false). */
  allowSymlinks?: boolean;
}

export interface GitToolOptions {
  env?: Env;
  timeoutMs?: number;
  gitBinary?: string;
  apply?: GitApplyRules;
  /**
   * Forbidden globs hidden from git.status/diff/log output (default:
   * DEFAULT_FORBIDDEN_PATHS; createToolBus passes the active policy's list).
   */
  forbiddenPaths?: readonly string[];
  /** Case-insensitive zone matching (default: on Windows only). */
  caseInsensitive?: boolean;
}

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT = 1024 * 1024;

/**
 * Repository config must not run programs on our behalf (review P2-F13, N4):
 * no fsmonitor, pager, external diff, signature verification (gpg.program),
 * and every configured filter driver is blanked per call (see filterArgs).
 * diff/log also pass --no-ext-diff/--no-textconv. Hooks point at a directory
 * that does not exist, and --no-optional-locks stops status from rewriting the
 * index (which fires post-index-change, review NF-2). Diff prefixes are forced
 * to a/ b/ so the zone filter can always parse headers (NF-1). No tool talks to
 * a remote, so core.sshCommand / credential helpers are never reached.
 */
const NO_HOOKS = path.join(tmpdir(), `kpai-no-hooks-${randomUUID()}`);
const HARDENING = [
  '--no-optional-locks',
  '-c',
  `core.hooksPath=${NO_HOOKS}`,
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'diff.srcPrefix=a/',
  '-c',
  'diff.dstPrefix=b/',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'diff.external=',
  '-c',
  'log.showSignature=false',
  // Submodules carry their own config and filters (review N4): never descend.
  '-c',
  'diff.ignoreSubmodules=all',
  '-c',
  'submodule.recurse=false',
  '-c',
  'status.submoduleSummary=false',
  '--no-pager',
];

/** Child env: scrubbed of secrets and of every GIT_* variable (GIT_DIR, GIT_EXTERNAL_DIFF…). */
function gitEnv(opts: GitToolOptions): Record<string, string> {
  const env = scrubEnv(opts.env ?? process.env);
  for (const k of Object.keys(env)) if (/^GIT_/i.test(k)) delete env[k];
  return { ...env, GIT_TERMINAL_PROMPT: '0' };
}

/** What git needs from a tool context: the root (default cwd) and the abort signal. */
export type GitCtx = Pick<ToolContext, 'root' | 'signal'>;

/** Per-call extras for internal callers (checkpoints, worktrees). */
export interface GitRunExtra {
  stdin?: string;
  cwd?: string;
  /** Added after scrubbing (e.g. GIT_INDEX_FILE for a temporary index, a fixed identity). */
  env?: Record<string, string>;
  maxOutputBytes?: number;
  /** Raw stdout bytes in `stdoutBytes` (blob contents). */
  binary?: boolean;
}

function spawnGit(
  opts: GitToolOptions,
  ctx: GitCtx,
  cwd: string,
  args: string[],
  extra: GitRunExtra = {},
): Promise<RunResult> {
  return runProcess({
    command: opts.gitBinary ?? 'git',
    args: [...HARDENING, ...args],
    cwd,
    env: { ...gitEnv(opts), ...extra.env },
    timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    maxOutputBytes: extra.maxOutputBytes ?? GIT_MAX_OUTPUT,
    stdin: extra.stdin,
    signal: ctx.signal,
    binary: extra.binary,
  });
}

/**
 * `-c filter.<name>.{clean,smudge,process}= -c filter.<name>.required=false` for
 * every filter driver in any config scope, so `.gitattributes` cannot make a
 * read tool (or git.apply) run a repository-defined program.
 */
export async function filterArgs(
  opts: GitToolOptions,
  ctx: GitCtx,
  cwd: string,
): Promise<string[]> {
  const r = await spawnGit(opts, ctx, cwd, ['config', '-z', '--get-regexp', '^filter\\.']);
  if (r.code !== 0) return [];
  const names = new Set<string>();
  for (const entry of r.stdout.split('\0')) {
    const key = entry.split('\n')[0] ?? '';
    const m = /^filter\.(.+)\.[^.]+$/s.exec(key);
    if (m) names.add(m[1] as string);
  }
  const args: string[] = [];
  for (const n of names) {
    for (const k of ['clean', 'smudge', 'process']) args.push('-c', `filter.${n}.${k}=`);
    args.push('-c', `filter.${n}.required=false`);
  }
  return args;
}

/** Runs git in the root (or `cwd`) with hardening and blanked filters. */
export async function git(
  opts: GitToolOptions,
  ctx: GitCtx,
  args: string[],
  stdin?: string,
  cwd?: string,
): Promise<RunResult> {
  return gitRun(opts, ctx, args, { stdin, cwd });
}

/** {@link git} with per-call extras (extra env, larger output cap, binary stdout). */
export async function gitRun(
  opts: GitToolOptions,
  ctx: GitCtx,
  args: string[],
  extra: GitRunExtra = {},
): Promise<RunResult> {
  const dir = extra.cwd ?? (await realpath(ctx.root));
  const filters = await filterArgs(opts, ctx, dir);
  return spawnGit(opts, ctx, dir, [...filters, ...args], extra);
}

export function outcome(r: RunResult, meta: Record<string, unknown> = {}): ToolOutcome {
  const m = { ...meta, exitCode: r.code, timedOut: r.timedOut, truncated: r.truncated };
  if (r.error) return fail(`git failed to start: ${r.error}`, m);
  if (r.timedOut) return fail('git timed out', m);
  if (r.code !== 0) return fail(`git exited with ${r.code}\n${r.stderr || r.stdout}`.trim(), m);
  return ok(r.stdout === '' ? '(no output)' : r.stdout, m);
}

export function failed(r: RunResult): boolean {
  return r.code !== 0 || r.error !== undefined || r.timedOut;
}
