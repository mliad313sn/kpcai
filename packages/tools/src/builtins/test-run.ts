/**
 * `test.run` (R-505, ADR-0032): runs the project's tests through the shell sandbox path
 * (scrubbed env, cwd = root, timeout, output cap; confirmed every call without an OS
 * sandbox) and returns the evidence first, the output tail after it.
 */
import type { ToolContext } from '@kernelpai/core';
import type { Env } from '../env.js';
import { resolveInRoot } from '../paths.js';
import { runProcess, type RunResult } from '../process.js';
import { detectSandbox, type ShellSandbox } from '../sandbox.js';
import { formatEvidence, TEST_RUN_TOOL } from '../test-evidence.js';
import { fail, ok, type LocalTool, type ToolOutcome } from '../types.js';
import {
  resolveTestCommand,
  withSelection,
  type TestCommand,
  type TestCommandConfig,
} from './test-detect.js';
import { evidenceOf, type ParserName } from './test-parse.js';

export interface TestRunToolOptions {
  /** The test command; detected from the workspace when absent. */
  command?: TestCommandConfig;
  sandbox?: ShellSandbox;
  env?: Env;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
}

export const TEST_RUN_DEFAULT_TIMEOUT_MS = 300_000;
export const TEST_RUN_MAX_TIMEOUT_MS = 1_800_000;
export const TEST_RUN_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Characters of output kept after the evidence (the tail, where runners summarise). */
export const TEST_RUN_TAIL_CHARS = 8_000;

const PARSERS = new Set<string>(['vitest', 'jest', 'pytest', 'go']);

function selection(input: Record<string, unknown>): { filter?: string; files: string[] } {
  const files = Array.isArray(input.files) ? input.files.map(String) : [];
  return typeof input.filter === 'string' ? { filter: input.filter, files } : { files };
}

async function planned(
  options: TestRunToolOptions,
  input: Record<string, unknown>,
  ctx: ToolContext,
) {
  const cmd = await resolveTestCommand(ctx.root, options.command);
  const { filter, files } = selection(input);
  for (const f of files) await resolveInRoot(ctx.root, f, { mustExist: true });
  return { cmd, args: withSelection(cmd, filter, files) };
}

async function runTests(
  options: TestRunToolOptions,
  sandbox: ShellSandbox,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const { cmd, args } = await planned(options, input, ctx);
  const timeoutMs =
    typeof input.timeoutMs === 'number'
      ? input.timeoutMs
      : (options.defaultTimeoutMs ?? TEST_RUN_DEFAULT_TIMEOUT_MS);
  const cwd = (await resolveInRoot(ctx.root, '.')).abs;
  const env = { ...(options.env ?? process.env), CI: 'true' };
  const prepared = sandbox.prepare({ command: cmd.command, args, cwd, env });
  const r = await runProcess({
    ...prepared,
    timeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? TEST_RUN_MAX_OUTPUT_BYTES,
    signal: ctx.signal,
  });
  return outcome(cmd, args, sandbox, r, timeoutMs);
}

/** The evidence header first, then the output tail; meta for the journal and grades. */
function outcome(
  cmd: TestCommand,
  args: string[],
  sandbox: ShellSandbox,
  r: RunResult,
  timeoutMs: number,
): ToolOutcome {
  const output = `${r.stdout}\n${r.stderr}`;
  const prefer = PARSERS.has(cmd.kind) ? (cmd.kind as ParserName) : undefined;
  const facts = {
    exitCode: r.code,
    timedOut: r.timedOut,
    aborted: r.aborted,
    error: r.error,
    output,
  };
  const e = evidenceOf(facts, prefer);
  const why = r.error
    ? `failed to start: ${r.error}`
    : r.timedOut
      ? `timed out after ${timeoutMs} ms`
      : '';
  const body = [
    formatEvidence(e),
    ...(why ? [why] : []),
    `--- output (last ${TEST_RUN_TAIL_CHARS} chars; untrusted test output) ---`,
    output.trim().slice(-TEST_RUN_TAIL_CHARS),
  ].join('\n');
  const meta = {
    // Grades read these (packages/learning: only a real test command counts).
    ...{ command: cmd.command, args, origin: cmd.origin, status: e.status, runner: e.runner },
    ...{ passed: e.passed, failed: e.failed, skipped: e.skipped, failing: e.failing },
    ...{ sandbox: sandbox.mode, exitCode: r.code, timedOut: r.timedOut, truncated: r.truncated },
    ...{ aborted: r.aborted, runMs: r.durationMs },
  };
  return e.status === 'passed' ? ok(body, meta) : fail(body, meta);
}

/** `test.run`: the project's tests, optionally narrowed by a name filter or files. */
export function testRunTool(options: TestRunToolOptions = {}): LocalTool {
  const sandbox = options.sandbox ?? detectSandbox();
  return {
    def: {
      name: TEST_RUN_TOOL,
      description:
        "Run the project's tests (runner detected or configured) and get passed/failed/skipped counts and failing test names first. `filter` narrows by test name; `files` to test files.",
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', minLength: 1, maxLength: 200 },
          files: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50 },
          timeoutMs: { type: 'integer', minimum: 1, maximum: TEST_RUN_MAX_TIMEOUT_MS },
        },
        additionalProperties: false,
      },
      // Tests run the project's own code: confirmed per batch, and every call when the OS
      // does not isolate the process (same rule as shell.run).
      risk: 'write',
      source: 'builtin',
    },
    alwaysConfirm: () => !sandbox.isolating,
    async prepare(input, ctx) {
      const { cmd, args } = await planned(options, input, ctx);
      const shown = [cmd.command, ...args].map((a) => JSON.stringify(a)).join(' ');
      return { summary: `run tests: ${shown} (${cmd.origin}; sandbox: ${sandbox.mode})` };
    },
    run: (input, ctx) => runTests(options, sandbox, input, ctx),
  };
}
