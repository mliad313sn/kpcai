/**
 * The tests signal (ADR-0028, P4-F10): which `shell.run` calls really ran tests, and what
 * their journaled output proves. The model still picks the command (and every such call
 * is confirmed by a human), so the forms that run nothing are refused: dry runs, listings,
 * help and version, "pass with no tests", `go env test`. Where the journal holds the whole
 * output, a pass also needs evidence that at least one test ran.
 */

const RUNNERS = new Set([
  'vitest',
  'jest',
  'mocha',
  'ava',
  'tap',
  'pytest',
  'py.test',
  'phpunit',
  'rspec',
  'ctest',
  'nose2',
  'tox',
]);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno']);
/** Build tools whose subcommand must be `test` (`go test`, never `go env test`). */
const SUBCOMMAND_TOOLS = new Set(['cargo', 'go', 'dotnet', 'swift', 'mix']);
/** Build tools whose goals may come in any order (`mvn -q clean test`). */
const GOAL_TOOLS = new Set(['mvn', 'gradle', 'make']);

/**
 * Long or short options (dashes, case, `-` and `_` ignored) that make a test command run
 * no test: `--passWithNoTests`, `--dry-run`, `--version`, `--help`, `--list`,
 * `--collect-only`, `--listTests`, `--no-run`, …
 */
const NO_OP_OPTIONS = new Set([
  'passwithnotests',
  'dryrun',
  'version',
  'help',
  'h',
  'list',
  'listtests',
  'collectonly',
  'co',
  'norun',
  'justprint',
  'recon',
  'question',
  'showconfig',
  'setupplan',
  'setuponly',
  'fixtures',
  'markers',
]);
/** Short options that are no-ops only for some tools (`pytest -n 4` is a real run). */
const NO_OP_SHORT: Readonly<Record<string, readonly string[]>> = {
  make: ['-n', '-q'],
  go: ['-n'],
  gradle: ['-m'],
  pytest: ['-V'],
  'py.test': ['-V'],
  mocha: ['-V'],
  tox: ['-V'],
};
const SKIP_TESTS = /^-D(skipTests|maven\.test\.skip)(=true)?$/i;

const base = (cmd: string): string =>
  (cmd.split(/[\\/]/).pop() ?? cmd).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
const positional = (args: readonly string[]): string | undefined =>
  args.find((a) => !a.startsWith('-') && !a.startsWith('+'));

/** The test tool and the arguments it receives, or undefined when this is no test run. */
function testTarget(command: string, args: readonly string[]): [string, string[]] | undefined {
  const cmd = base(command);
  const first = (args[0] ?? '').toLowerCase();
  if (RUNNERS.has(cmd)) return [cmd, args.slice()];
  if (cmd === 'npx' || cmd === 'pnpx' || cmd === 'bunx') {
    return RUNNERS.has(base(first)) ? [base(first), args.slice(1)] : undefined;
  }
  if (PACKAGE_MANAGERS.has(cmd)) {
    if (first === 'test' || first === 't') return [cmd, args.slice(1)];
    const script = (args[1] ?? '').toLowerCase();
    if (first === 'exec' || first === 'dlx') {
      return RUNNERS.has(base(script)) ? [base(script), args.slice(2)] : undefined;
    }
    return first === 'run' && /^test(:|$)/.test(script) ? [cmd, args.slice(2)] : undefined;
  }
  if (/^python(\d(\.\d+)?)?$/.test(cmd)) {
    const mod = args[1] ?? '';
    return first === '-m' && RUNNERS.has(mod) ? [mod, args.slice(2)] : undefined;
  }
  if (SUBCOMMAND_TOOLS.has(cmd))
    return positional(args) === 'test' ? [cmd, args.slice()] : undefined;
  return GOAL_TOOLS.has(cmd) && args.includes('test') ? [cmd, args.slice()] : undefined;
}

/** True when an argument turns the test command into one that runs no test. */
function isNoOp(tool: string, a: string): boolean {
  if ((NO_OP_SHORT[tool] ?? []).includes(a) || SKIP_TESTS.test(a)) return true;
  if (!a.startsWith('-')) return false;
  const name = a.replace(/^-+/, '').split('=')[0] ?? '';
  return NO_OP_OPTIONS.has(name.toLowerCase().replace(/[-_]/g, ''));
}

/**
 * True when a `shell.run` call is a test run: a test runner (`vitest`, `pytest`, …), a
 * package manager's `test` script (`npm test`, `pnpm run test:unit`), `npx vitest`,
 * `python -m pytest`, or a build tool's `test` goal (`go test`, `cargo test`, `make test`)
 * — and none of its arguments makes it a no-op (dry run, listing, help, version,
 * `--passWithNoTests`, `vitest list`, Maven `-DskipTests`).
 */
export function isTestCommand(command: string, args: readonly string[]): boolean {
  const target = testTarget(command, args);
  if (!target) return false;
  const [tool, rest] = target;
  if (RUNNERS.has(tool) && positional(rest) === 'list') return false;
  return !rest.some((a) => isNoOp(tool, a));
}

/** Runner summaries that show at least one test ran (vitest, jest, pytest, mocha, go, …). */
const RAN = [
  /\b[1-9]\d*\s+(tests?\s+)?(passed|passing|pass)\b/i,
  /^#\s*pass\s+[1-9]/im,
  /^ok\s+\S+\s+(\(cached\)|[\d.]+m?s)/m,
  /\bOK \([1-9]\d* tests?/,
  /\bRan [1-9]\d* tests?\b/,
  /\b[1-9]\d* examples?, 0 failures\b/,
  /\btests passed, 0 tests failed out of [1-9]/,
  /\bPassed:\s+[1-9]/,
];
/** Runner messages that say no test ran. */
const NONE = [
  /\bno tests? (files? )?(were |was )?(found|ran|run|collected|executed)/i,
  /\[no test files\]/i,
  /\bno tests to run\b/i,
  /\bcollected 0 items\b/i,
  /\brunning 0 tests\b/i,
  /\bTests?:?\s+0 total\b/i,
];

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export interface ShellOutput {
  exitCode?: unknown;
  timedOut?: unknown;
  aborted?: unknown;
  /** The journaled result: `{ preview, chars, sha256? }`; `sha256` marks a cut preview. */
  result?: unknown;
}

/** The journaled output text and whether it is complete, if any. */
function outputOf(result: unknown): { text: string; whole: boolean } | undefined {
  const r = (result ?? {}) as { preview?: unknown; sha256?: unknown };
  if (typeof r.preview !== 'string') return undefined;
  return { text: r.preview.replace(ANSI, ''), whole: r.sha256 === undefined };
}

/**
 * Outcome of a test command: true passed, false failed, undefined when it proves nothing
 * (aborted, no exit code, no test ran, or a whole output without a single test passing).
 */
export function testRunOutcome(o: ShellOutput): boolean | undefined {
  if (o.aborted === true) return undefined;
  if (o.timedOut === true) return false;
  // No exit code: the program was missing or refused; that says nothing of the code.
  if (typeof o.exitCode !== 'number') return undefined;
  const out = outputOf(o.result);
  const ran = out !== undefined && RAN.some((re) => re.test(out.text));
  if (!ran && out !== undefined && NONE.some((re) => re.test(out.text))) return undefined;
  if (o.exitCode !== 0) return false;
  return ran || out?.whole !== true ? true : undefined;
}
