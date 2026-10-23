import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '@kernelpai/core';
import { scrubEnv, type Env } from '../env.js';
import { checkLexical, resolveInRoot, touchesGitDir } from '../paths.js';
import { runProcess, type RunResult } from '../process.js';
import { fail, ok, ToolError, type LocalTool, type ToolOutcome } from '../types.js';

export interface GitToolOptions {
  env?: Env;
  timeoutMs?: number;
  gitBinary?: string;
}

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT = 1024 * 1024;
/**
 * Repo config must not run programs on our behalf: no fsmonitor, no pager, and
 * diff/log get --no-ext-diff --no-textconv. status/diff/log/apply run no hooks.
 */
const HARDENING = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '--no-pager',
  '--literal-pathspecs',
];

async function git(
  opts: GitToolOptions,
  ctx: ToolContext,
  args: string[],
  stdin?: string,
  confine = false,
): Promise<RunResult> {
  const cwd = await realpath(ctx.root);
  const env: Record<string, string> = {
    ...scrubEnv(opts.env ?? process.env),
    GIT_TERMINAL_PROMPT: '0',
  };
  // Confined: git may not discover a repository above the root, so patch paths are
  // always root-relative (from a subdirectory, `diff --git` patches would otherwise
  // be resolved against the top level and silently skipped).
  if (confine) env.GIT_CEILING_DIRECTORIES = path.dirname(cwd);
  return runProcess({
    command: opts.gitBinary ?? 'git',
    args: [...HARDENING, ...args],
    cwd,
    env,
    timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    maxOutputBytes: GIT_MAX_OUTPUT,
    stdin,
    signal: ctx.signal,
  });
}

function outcome(r: RunResult, meta: Record<string, unknown> = {}): ToolOutcome {
  const m = { ...meta, exitCode: r.code, timedOut: r.timedOut, truncated: r.truncated };
  if (r.error) return fail(`git failed to start: ${r.error}`, m);
  if (r.timedOut) return fail('git timed out', m);
  if (r.code !== 0) return fail(`git exited with ${r.code}\n${r.stderr || r.stdout}`.trim(), m);
  return ok(r.stdout === '' ? '(no output)' : r.stdout, m);
}

/** Jails optional pathspecs; returns them root-relative, after a `--`. */
async function pathspecs(ctx: ToolContext, p: unknown): Promise<string[]> {
  // Default `.` keeps output to the root when the root is a repo subdirectory.
  if (p === undefined) return ['--', '.'];
  const j = await resolveInRoot(ctx.root, p);
  return ['--', j.rel];
}

const optPath = { type: 'string' } as const;

/** Files a patch touches, from `a/…` / `b/…` headers; refuses anything else. */
export function patchTargets(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (/^(new|old|deleted) (file )?mode 120000/.test(line)) {
      throw new ToolError('patches that create or change symlinks are refused');
    }
    const h = /^(---|\+\+\+) (.+?)(\t.*)?$/.exec(line);
    if (h) {
      const name = h[2] as string;
      if (name === '/dev/null') continue;
      if (!/^[ab]\//.test(name))
        throw new ToolError(`patch paths must start with a/ or b/: ${name}`);
      out.add(name.slice(2));
    }
    const r = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (r) out.add(r[1] as string);
  }
  if (out.size === 0) throw new ToolError('no file headers (--- a/… +++ b/…) found in the patch');
  return [...out];
}

async function checkTargets(ctx: ToolContext, patch: string): Promise<string[]> {
  const targets = patchTargets(patch);
  for (const t of targets) {
    checkLexical(t);
    const j = await resolveInRoot(ctx.root, t, { noFinalSymlink: true });
    if (touchesGitDir(j.rel)) throw new ToolError(`patch may not touch .git: ${t}`);
  }
  return targets;
}

function gitApply(opts: GitToolOptions): LocalTool {
  return {
    def: {
      name: 'git.apply',
      description:
        'Apply a unified diff (with a/ and b/ prefixes) to the workspace. Checked with `git apply --check` first.',
      inputSchema: {
        type: 'object',
        properties: { patch: { type: 'string', minLength: 1 } },
        required: ['patch'],
        additionalProperties: false,
      },
      risk: 'write',
      source: 'builtin',
    },
    async run(input, ctx) {
      const patch = String(input.patch);
      const files = await checkTargets(ctx, patch);
      const meta = { files, bytes: Buffer.byteLength(patch, 'utf8') };
      const check = await git(opts, ctx, ['apply', '--check', '-'], patch, true);
      if (check.code !== 0 || check.error || check.timedOut) {
        return outcome(check, { ...meta, stage: 'check' });
      }
      const applied = await git(opts, ctx, ['apply', '-'], patch, true);
      if (applied.code !== 0) return outcome(applied, { ...meta, stage: 'apply' });
      return ok(`applied patch to ${files.length} file(s): ${files.join(', ')}`, meta);
    },
  };
}

const LOG_FORMAT = ['--no-ext-diff', '--format=%h %ad %an %s', '--date=short'];

function readTools(opts: GitToolOptions): LocalTool[] {
  const def = (name: string, description: string, properties: Record<string, unknown>) => ({
    name,
    description,
    inputSchema: { type: 'object', properties, additionalProperties: false },
    risk: 'read' as const,
    source: 'builtin',
  });
  return [
    {
      def: def('git.status', 'Show the working tree status (porcelain, with branch).', {}),
      run: async (_input, ctx) => {
        const spec = await pathspecs(ctx, undefined);
        return outcome(await git(opts, ctx, ['status', '--porcelain=v1', '-b', ...spec]));
      },
    },
    {
      def: def('git.diff', 'Show unstaged changes, or staged ones with `staged: true`.', {
        staged: { type: 'boolean' },
        path: optPath,
      }),
      run: async (input, ctx) => {
        const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
        if (input.staged === true) args.push('--cached');
        return outcome(await git(opts, ctx, [...args, ...(await pathspecs(ctx, input.path))]));
      },
    },
    {
      def: def('git.log', 'Show recent commits (one line each, at most 100).', {
        maxCount: { type: 'integer', minimum: 1, maximum: 100 },
        path: optPath,
      }),
      run: async (input, ctx) => {
        const n = typeof input.maxCount === 'number' ? input.maxCount : 20;
        const args = ['log', '--no-color', `--max-count=${n}`, ...LOG_FORMAT];
        return outcome(await git(opts, ctx, [...args, ...(await pathspecs(ctx, input.path))]));
      },
    },
  ];
}

export function gitTools(opts: GitToolOptions = {}): LocalTool[] {
  return [...readTools(opts), gitApply(opts)];
}
