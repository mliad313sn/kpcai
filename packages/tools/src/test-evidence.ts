/**
 * Test results as evidence (R-505, ADR-0032). `test.run` starts its result with one
 * header line it writes itself, before any test output, so a reader (the critic step in
 * the orchestrator) can trust the status: test output, which is untrusted, only follows it.
 */
import { stripControls } from './text.js';

export const TEST_RUN_TOOL = 'test.run';

export type TestStatus = 'passed' | 'failed' | 'no-tests' | 'error';

export interface TestCounts {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
}

export interface TestEvidence extends TestCounts {
  status: TestStatus;
  /** Which parser read the output (`vitest`, `jest`, `pytest`, `go`, `exit-code`). */
  runner: string;
  exitCode: number | null;
  /** Failing test names, from the test output (untrusted text), at most 20. */
  failing: string[];
  /**
   * P5-F4, P5-R2 (D-035): test configuration or runner-side files the run changed before
   * this test run, and what left the runner unverified (`… (runner unverified)`). A
   * tampered run is shown to the critic and counts as no test evidence anywhere.
   */
  tampered?: string[];
}

export const MAX_FAILING = 20;
const FAILING_HEAD = 'failing tests:';
const TAMPERED_HEAD =
  'tampered (this run changed its own test configuration or runner; not test evidence): ';
const MAX_TAMPERED = 10;
const HEADER =
  /^test\.run: (passed|failed|no-tests|error) \(([\w.-]{1,32}), exit (-?\d+|none)\)(?:: (\d+|\?) passed, (\d+|\?) failed, (\d+|\?) skipped)?$/;

const n = (v: number | null): string => (v === null ? '?' : String(v));
const num = (s: string | undefined): number | null =>
  s === undefined || s === '?' ? null : Number(s);

/** The header and failing-test lines `test.run` puts first in its result. */
export function formatEvidence(e: TestEvidence): string {
  const counts =
    e.passed === null && e.failed === null && e.skipped === null
      ? ''
      : `: ${n(e.passed)} passed, ${n(e.failed)} failed, ${n(e.skipped)} skipped`;
  const head = `test.run: ${e.status} (${e.runner}, exit ${e.exitCode ?? 'none'})${counts}`;
  const tampered = e.tampered?.length
    ? [TAMPERED_HEAD + e.tampered.slice(0, MAX_TAMPERED).map(oneLine).join(', ')]
    : [];
  if (e.failing.length === 0) return [head, ...tampered].join('\n');
  const names = e.failing.slice(0, MAX_FAILING).map((f) => `- ${oneLine(f)}`);
  return [head, ...tampered, FAILING_HEAD, ...names].join('\n');
}

function oneLine(s: string): string {
  return stripControls(s).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Reads the evidence back from a `test.run` result; undefined when the result does not
 * start with the header (a refused or failed call, or another tool).
 */
export function readTestEvidence(content: string): TestEvidence | undefined {
  const lines = content.split('\n');
  const m = HEADER.exec(lines[0] ?? '');
  if (!m) return undefined;
  const t = lines[1]?.startsWith(TAMPERED_HEAD) ? lines[1].slice(TAMPERED_HEAD.length) : undefined;
  const at = t === undefined ? 1 : 2;
  const failing: string[] = [];
  if (lines[at] === FAILING_HEAD) {
    for (const l of lines.slice(at + 1, at + 1 + MAX_FAILING)) {
      if (!l.startsWith('- ')) break;
      failing.push(l.slice(2));
    }
  }
  return {
    status: m[1] as TestStatus,
    runner: m[2] as string,
    exitCode: m[3] === 'none' ? null : Number(m[3]),
    passed: num(m[4]),
    failed: num(m[5]),
    skipped: num(m[6]),
    failing,
    ...(t !== undefined ? { tampered: t.split(', ').filter((f) => f !== '') } : {}),
  };
}

/** True when the evidence shows the work does not pass its tests. */
export function testsFailed(e: TestEvidence | undefined): boolean {
  return e !== undefined && (e.status === 'failed' || e.status === 'error');
}

/** One short sentence for a verdict issue or a journal reason. */
export function evidenceSummary(e: TestEvidence): string {
  const counts = e.failed === null ? '' : ` (${n(e.failed)} failed, ${n(e.passed)} passed)`;
  const names = e.failing.length > 0 ? `: ${e.failing.slice(0, 5).map(oneLine).join('; ')}` : '';
  const what = {
    passed: 'tests passed',
    failed: 'tests failed',
    'no-tests': 'no test ran',
    error: 'the test run did not complete',
  }[e.status];
  const tampered = e.tampered?.length
    ? ' (tampered: the run changed its test configuration or runner)'
    : '';
  return `${what}${counts} [${e.runner}]${tampered}${names}`.slice(0, 600);
}
