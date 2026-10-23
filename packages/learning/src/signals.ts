/**
 * Grading signals (ADR-0028, spec §5.4, R-401). Each signal is read from a journaled event
 * and carries a value in [0, 1] and a weight; a node's grade is their weighted mean.
 */

export type SignalKind =
  'critic' | 'tests' | 'patch' | 'rollback' | 'cancelled' | 'bench' | 'manual';

export interface Signal {
  kind: SignalKind;
  /** 1 = good outcome, 0 = bad outcome. */
  value: number;
  weight: number;
  /** Journal sequence number of the event behind the signal (traceability). */
  seq: number;
}

/**
 * Weights of the signals. Objective, human-confirmed outcomes weigh most: a manual grade,
 * a rollback (the human undid the work), then tests. A critic verdict is one model's
 * opinion; a cancellation says little about the node itself.
 */
export const SIGNAL_WEIGHTS: Readonly<Record<SignalKind, number>> = {
  manual: 3,
  rollback: 2,
  tests: 1.5,
  critic: 1,
  patch: 1,
  bench: 1,
  cancelled: 0.5,
};

/** A critic of the same provider as the author (diversity waived) counts half. */
export const SAME_PROVIDER_CRITIC_FACTOR = 0.5;

/** Roles whose answer is the node's output (the producer graded by node-level signals). */
export const PRODUCER_ROLES: ReadonlySet<string> = new Set(['solo', 'author', 'revision']);

/** Stop reasons that are not a finished answer. */
export const NOT_ANSWERED: ReadonlySet<string> = new Set(['cancelled', 'refusal', 'tool_use']);

/** Journaled intervention actions this package reads or writes. */
export const ACTIONS = {
  grade: 'grade',
  benchCheck: 'bench check',
  benchRun: 'bench run',
  outcome: 'run outcome',
  cancelGraph: 'cancel graph',
  cancel: 'cancel',
  checkpoint: 'checkpoint',
  restore: 'restore',
  mergeDeclined: 'merge-back declined',
  patchRefused: 'patch refused: control characters',
} as const;

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
const BUILD_TOOLS = new Set(['cargo', 'go', 'dotnet', 'mvn', 'gradle', 'make', 'swift', 'mix']);

const base = (cmd: string): string =>
  (cmd.split(/[\\/]/).pop() ?? cmd).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');

/**
 * True when a `shell.run` call is a test run: a test runner (`vitest`, `pytest`, …), a
 * package manager's `test` script (`npm test`, `pnpm run test:unit`), `npx vitest`,
 * `python -m pytest`, or a build tool's `test` goal (`go test`, `cargo test`, `make test`).
 */
export function isTestCommand(command: string, args: readonly string[]): boolean {
  const cmd = base(command);
  const first = (args[0] ?? '').toLowerCase();
  if (RUNNERS.has(cmd)) return true;
  if (cmd === 'npx' || cmd === 'pnpx' || cmd === 'bunx') return RUNNERS.has(base(first));
  if (PACKAGE_MANAGERS.has(cmd)) {
    if (first === 'test' || first === 't') return true;
    const script = (args[1] ?? '').toLowerCase();
    if (first === 'exec' || first === 'dlx') return RUNNERS.has(base(script));
    return first === 'run' && /^test(:|$)/.test(script);
  }
  if (/^python(\d(\.\d+)?)?$/.test(cmd)) return first === '-m' && RUNNERS.has(args[1] ?? '');
  return BUILD_TOOLS.has(cmd) && (first === 'test' || args.includes('test'));
}

/** Weighted mean of the signals; undefined without any weight. */
export function weightedGrade(signals: readonly Signal[]): number | undefined {
  let w = 0;
  let sum = 0;
  for (const s of signals) {
    w += s.weight;
    sum += s.weight * s.value;
  }
  return w > 0 ? sum / w : undefined;
}
