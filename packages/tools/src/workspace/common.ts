import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  gitRun,
  failed,
  type GitCtx,
  type GitRunExtra,
  type GitToolOptions,
} from '../builtins/git-exec.js';
import type { ZoneFilter } from '../builtins/git-filter.js';
import {
  DEFAULT_ZONES,
  defaultCaseInsensitive,
  inForbiddenZone,
  zoneSetFromGlobs,
  type ZoneSet,
} from '../zones.js';
import { stripControls } from '../text.js';
import { ToolError } from '../types.js';

/** Options shared by the checkpoint, rules and worktree APIs. */
export interface WorkspaceOptions {
  /** Git runner options (binary, timeout, env). Apply rules are used by mergeBack. */
  git?: GitToolOptions;
  /** `$KPAI_HOME` (default: env KPAI_HOME, else ~/.kernelpai). */
  home?: string;
  /** Forbidden globs (default: DEFAULT_FORBIDDEN_PATHS; the credential tier is always added). */
  forbiddenPaths?: readonly string[];
  /** The effective zone set (the active policy's `zoneSet()`); wins over `forbiddenPaths`. */
  zones?: ZoneSet;
  /** Case-insensitive zone matching (default: on Windows only). */
  caseInsensitive?: boolean;
  signal?: AbortSignal;
}

/** Large plumbing outputs (file lists, hashes, diffs): never silently cut. */
export const PLUMBING_MAX_OUTPUT = 64 * 1024 * 1024;

/** Identity for checkpoint commits, so they work without user.name / user.email. */
export const KPAI_IDENT: Record<string, string> = {
  GIT_AUTHOR_NAME: 'KernelPAI',
  GIT_AUTHOR_EMAIL: 'kpai@localhost',
  GIT_COMMITTER_NAME: 'KernelPAI',
  GIT_COMMITTER_EMAIL: 'kpai@localhost',
};

/** Run ids become ref and directory names: letters, digits, `-`, `_` (no dots: no `..`, `.lock`). */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function checkRunId(run: string): string {
  if (typeof run !== 'string' || !RUN_ID.test(run)) {
    throw new ToolError(`invalid run id (letters, digits, - and _ only, at most 64): ${run}`);
  }
  return run;
}

export function zonesOf(opts: WorkspaceOptions): ZoneFilter {
  if (opts.zones) return opts.zones;
  const ci = opts.caseInsensitive ?? defaultCaseInsensitive();
  return zoneSetFromGlobs(opts.forbiddenPaths ?? DEFAULT_ZONES, ci);
}

export function inZone(rel: string, zones: ZoneFilter): boolean {
  return inForbiddenZone(rel, zones);
}

export function kpaiHome(opts: WorkspaceOptions): string {
  const env = opts.git?.env ?? process.env;
  return opts.home ?? (env['KPAI_HOME']?.trim() || path.join(homedir(), '.kernelpai'));
}

export function gctx(root: string, opts: WorkspaceOptions): GitCtx {
  return { root, signal: opts.signal };
}

/** Runs git and returns stdout; any failure (exit code, timeout, truncation) throws. */
export async function gitOut(
  opts: WorkspaceOptions,
  root: string,
  args: string[],
  extra: GitRunExtra = {},
): Promise<string> {
  const r = await gitRun(opts.git ?? {}, gctx(root, opts), args, {
    maxOutputBytes: PLUMBING_MAX_OUTPUT,
    ...extra,
  });
  if (failed(r) || r.truncated) {
    const why = r.truncated ? 'output too large' : stripControls(r.stderr || r.error || '');
    throw new ToolError(`git ${args[0] ?? ''} failed: ${why.trim().slice(0, 1000)}`);
  }
  return r.stdout;
}

/** Where a workspace root sits in its repository. */
export interface RepoInfo {
  /** Real path of the working tree top level. */
  top: string;
  /** Root relative to top, `/`-separated with a trailing `/` (`''` at the top). */
  prefix: string;
  /** Real path of the common git dir (shared by all worktrees). */
  commonDir: string;
  /** HEAD commit, or undefined on an unborn branch. */
  head: string | undefined;
}

export async function repoInfo(opts: WorkspaceOptions, root: string): Promise<RepoInfo> {
  const real = await realpath(root).catch(() => {
    throw new ToolError('workspace root does not exist');
  });
  const out = await gitOut(opts, real, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-common-dir',
    '--show-prefix',
  ]).catch(() => {
    throw new ToolError('workspace root is not inside a git working tree');
  });
  const [top = '', common = '', prefix = ''] = out.split(/\r?\n/);
  if (top === '') throw new ToolError('workspace root is not inside a git working tree');
  const head = await gitOut(opts, real, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
    .then((s) => s.trim())
    .catch(() => undefined);
  return { top: await realpath(top), prefix, commonDir: await realpath(common), head };
}

/** Stable short id of a repository (its common git dir), for `$KPAI_HOME/worktrees/<hash>`. */
export function repoHash(info: RepoInfo): string {
  const key = process.platform === 'win32' ? info.commonDir.toLowerCase() : info.commonDir;
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

/** One line, no control characters, at most 200 chars (labels go into commit messages). */
export function cleanLabel(label: string): string {
  const one = stripControls(String(label)).replace(/\s+/g, ' ').trim();
  return (one === '' ? 'checkpoint' : one).slice(0, 200);
}
