import { describe, expect, it } from 'vitest';
import {
  evidenceSummary,
  formatEvidence,
  readTestEvidence,
  testsFailed,
  type TestEvidence,
} from '../test-evidence.js';
import { evidenceOf, parseOutput } from './test-parse.js';

const run = (output: string, exitCode: number | null = 0) =>
  evidenceOf({ output, exitCode, timedOut: false, aborted: false });

describe('runner output parsers', () => {
  it('reads vitest, with ANSI colours and todo tests', () => {
    const out =
      '\u001b[31m FAIL \u001b[39m src/x.test.ts > a > b\n      Tests  1 failed | 4 passed | 1 todo (6)\n';
    expect(parseOutput(out)).toEqual({
      runner: 'vitest',
      passed: 4,
      failed: 1,
      skipped: 1,
      failing: ['src/x.test.ts > a > b'],
    });
  });

  it('reads jest', () => {
    const out = [
      '  ● Math › adds',
      '',
      '    expect(received).toBe(expected)',
      'Tests:       1 failed, 1 skipped, 3 passed, 5 total',
    ].join('\n');
    expect(run(out, 1)).toMatchObject({
      status: 'failed',
      runner: 'jest',
      passed: 3,
      failed: 1,
      skipped: 1,
      failing: ['Math › adds'],
    });
  });

  it('reads pytest, errors counted as failures; nothing collected is no-tests', () => {
    const out = [
      'FAILED tests/test_a.py::test_one - assert 1 == 2',
      'ERROR tests/test_b.py::test_two',
      '==== 1 failed, 3 passed, 2 skipped, 1 error in 0.12s ====',
    ].join('\n');
    expect(run(out, 1)).toMatchObject({
      status: 'failed',
      runner: 'pytest',
      passed: 3,
      failed: 2,
      skipped: 2,
      failing: ['tests/test_a.py::test_one', 'tests/test_b.py::test_two'],
    });
    expect(run('==== no tests ran in 0.01s ====', 5).status).toBe('no-tests');
    expect(run('===== 5 passed in 1.00s =====').status).toBe('passed');
  });

  it('reads go test -json and plain go test', () => {
    const json = [
      '{"Action":"run","Package":"p","Test":"TestA"}',
      '{"Action":"pass","Package":"p","Test":"TestA"}',
      '{"Action":"fail","Package":"p","Test":"TestB"}',
      '{"Action":"skip","Package":"p","Test":"TestC"}',
      '{"Action":"fail","Package":"p"}',
      '{not json',
    ].join('\n');
    expect(run(json, 1)).toMatchObject({
      runner: 'go',
      status: 'failed',
      passed: 1,
      failed: 1,
      skipped: 1,
      failing: ['p.TestB'],
    });
    const text = '--- FAIL: TestB (0.00s)\n--- PASS: TestA (0.00s)\nFAIL\tp\t0.01s\n';
    expect(run(text, 1)).toMatchObject({ runner: 'go', passed: 1, failed: 1, failing: ['TestB'] });
    // Without -v only package lines: counts unknown, the exit code decides.
    expect(run('ok  \tp\t0.01s\n')).toMatchObject({ status: 'passed', passed: null });
    expect(run('ok  \tp\t0.01s [no tests to run]\n?   \tq\t[no test files]\n').status).toBe(
      'no-tests',
    );
  });

  it('decides status: failed beats passed, a pass needs a passing test, errors', () => {
    expect(run('      Tests  2 passed (2)', 1).status).toBe('failed');
    expect(run('      Tests  0 passed (0)', 0).status).toBe('no-tests');
    expect(run('      Tests  0 passed (0)', 2).status).toBe('failed');
    expect(run('No test files found', 1).status).toBe('no-tests');
    expect(run('whatever', 0)).toMatchObject({ status: 'passed', runner: 'exit-code' });
    expect(run('whatever', 1).status).toBe('failed');
    expect(run('x', null).status).toBe('error');
    const t = evidenceOf({ output: '', exitCode: null, timedOut: true, aborted: false });
    expect(t.status).toBe('error');
    expect(
      evidenceOf({ output: '', exitCode: 0, timedOut: false, aborted: false, error: 'ENOENT' })
        .status,
    ).toBe('error');
  });
});

describe('evidence header', () => {
  const e: TestEvidence = {
    status: 'failed',
    runner: 'vitest',
    exitCode: 1,
    passed: 2,
    failed: 1,
    skipped: null,
    failing: ['a > b\u001b[2J', 'c\nd'],
  };

  it('round-trips and sanitises failing names', () => {
    const text = `${formatEvidence(e)}\n--- output ---\n- not a name`;
    expect(text.split('\n').slice(0, 4)).toEqual([
      'test.run: failed (vitest, exit 1): 2 passed, 1 failed, ? skipped',
      'failing tests:',
      '- a > b',
      '- c d',
    ]);
    expect(readTestEvidence(text)).toEqual({ ...e, failing: ['a > b', 'c d'] });
    const bare = {
      ...e,
      passed: null,
      failed: null,
      failing: [],
      exitCode: null,
      status: 'error' as const,
    };
    expect(readTestEvidence(formatEvidence(bare))).toEqual(bare);
    expect(readTestEvidence('permission declined: test.run')).toBeUndefined();
  });

  it('summarises and flags failures', () => {
    expect(evidenceSummary(e)).toBe('tests failed (1 failed, 2 passed) [vitest]: a > b; c d');
    expect(evidenceSummary({ ...e, status: 'no-tests', failed: null, failing: [] })).toBe(
      'no test ran [vitest]',
    );
    expect(testsFailed(e)).toBe(true);
    expect(testsFailed({ ...e, status: 'error' })).toBe(true);
    expect(testsFailed({ ...e, status: 'no-tests' })).toBe(false);
    expect(testsFailed(undefined)).toBe(false);
  });
});
