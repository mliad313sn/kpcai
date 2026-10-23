import type { ToolContext, ToolRisk } from '@kernelpai/core';
import type { Env } from '../env.js';
import { checkLexical, resolveInRoot } from '../paths.js';
import { runProcess } from '../process.js';
import { detectSandbox, type ShellSandbox } from '../sandbox.js';
import { fail, ok, ToolError, type LocalTool, type ToolOutcome } from '../types.js';

/**
 * Commands that only read, classed `write` (confirmed per batch) instead of
 * `destructive`. Each entry is a command plus a required argument prefix.
 */
export const DEFAULT_SHELL_ALLOWLIST: readonly string[] = [
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'git status',
  'git diff',
  'git log',
];

export interface ShellToolOptions {
  /** Read-only command allow-list (`"git status"`, `"npx vitest run"`). */
  allowlist?: readonly string[];
  sandbox?: ShellSandbox;
  env?: Env;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
}

export const SHELL_DEFAULT_TIMEOUT_MS = 60_000;
export const SHELL_MAX_TIMEOUT_MS = 600_000;
export const SHELL_MAX_OUTPUT_BYTES = 256 * 1024;

const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function argList(input: Record<string, unknown>): string[] {
  return Array.isArray(input.args) ? input.args.map(String) : [];
}

/** Extra arguments after an allow-listed prefix must stay inside root and not be long options. */
function harmlessArg(a: string): boolean {
  if (a.startsWith('--')) return false;
  try {
    checkLexical(a);
  } catch {
    return false;
  }
  return !/^[\\/]/.test(a);
}

export function isAllowlisted(
  allowlist: readonly string[],
  command: string,
  args: readonly string[],
): boolean {
  return allowlist.some((entry) => {
    const [cmd, ...prefix] = entry.trim().split(/\s+/);
    if (cmd !== command || prefix.some((p, i) => args[i] !== p)) return false;
    return args.slice(prefix.length).every(harmlessArg);
  });
}

async function resolveCommand(ctx: ToolContext, command: string): Promise<string> {
  if (BARE_COMMAND.test(command)) return command;
  if (/^\.{1,2}$/.test(command)) throw new ToolError(`not a command: ${command}`);
  if (/^([\\/]|[a-zA-Z]:)/.test(command)) {
    throw new ToolError('absolute command paths are refused; use a bare name or a relative path');
  }
  // A relative program path must live inside the workspace.
  return (await resolveInRoot(ctx.root, command, { mustExist: true })).abs;
}

function render(r: Awaited<ReturnType<typeof runProcess>>, timeoutMs: number): string {
  const head = r.error
    ? `failed to start: ${r.error}`
    : r.timedOut
      ? `timed out after ${timeoutMs} ms`
      : `exit code ${r.code ?? 'killed'}`;
  const parts = [head];
  if (r.truncated) parts.push('[output truncated]');
  if (r.stdout) parts.push(`--- stdout ---\n${r.stdout}`);
  if (r.stderr) parts.push(`--- stderr ---\n${r.stderr}`);
  return parts.join('\n');
}

async function runShell(
  options: ShellToolOptions,
  sandbox: ShellSandbox,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const command = await resolveCommand(ctx, String(input.command));
  const timeoutMs =
    typeof input.timeoutMs === 'number'
      ? input.timeoutMs
      : (options.defaultTimeoutMs ?? SHELL_DEFAULT_TIMEOUT_MS);
  const cwd = (await resolveInRoot(ctx.root, '.')).abs;
  const env = options.env ?? process.env;
  const cmd = sandbox.prepare({ command, args: argList(input), cwd, env });
  const r = await runProcess({
    ...cmd,
    timeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? SHELL_MAX_OUTPUT_BYTES,
    signal: ctx.signal,
  });
  const meta = {
    sandbox: sandbox.mode,
    exitCode: r.code,
    timedOut: r.timedOut,
    truncated: r.truncated,
    aborted: r.aborted,
    runMs: r.durationMs,
  };
  const failed = r.error !== undefined || r.timedOut || r.aborted || r.code !== 0;
  return failed ? fail(render(r, timeoutMs), meta) : ok(render(r, timeoutMs), meta);
}

/** `shell.run`: spawns `command` with `args` (no shell), cwd = root, scrubbed env. */
export function shellTool(options: ShellToolOptions = {}): LocalTool {
  const sandbox = options.sandbox ?? detectSandbox();
  const allowlist = options.allowlist ?? DEFAULT_SHELL_ALLOWLIST;
  return {
    def: {
      name: 'shell.run',
      description:
        'Run a program in the workspace: `command` is a program name, `args` its arguments (no shell syntax: pipes, globs and redirections are not interpreted).',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', minLength: 1, maxLength: 256 },
          args: { type: 'array', items: { type: 'string' }, maxItems: 256 },
          timeoutMs: { type: 'integer', minimum: 1, maximum: SHELL_MAX_TIMEOUT_MS },
        },
        required: ['command', 'args'],
        additionalProperties: false,
      },
      risk: 'destructive',
      source: 'builtin',
    },
    riskFor(input): ToolRisk {
      const listed = isAllowlisted(allowlist, String(input.command), argList(input));
      return listed ? 'write' : 'destructive';
    },
    alwaysConfirm: () => !sandbox.isolating,
    run: (input, ctx) => runShell(options, sandbox, input, ctx),
  };
}
