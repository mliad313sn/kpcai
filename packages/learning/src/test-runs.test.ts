import { describe, expect, it } from 'vitest';
import { gradeJournal } from './grades.js';
import { isTestCommand, testRunOutcome } from './test-runs.js';
import { Script } from './test-helpers/script.js';

describe('isTestCommand refuses forms that run no test (P4-F10)', () => {
  it.each([
    ['vitest', ['run', '--passWithNoTests', 'nonexistent']],
    ['make', ['-n', 'test']],
    ['go', ['env', 'test']],
    ['npx', ['vitest', 'list']],
    ['npx', ['jest', '--listTests']],
    ['pnpm', ['test', '--', '--pass-with-no-tests']],
    ['npm', ['test', '--dry-run']],
    ['pytest', ['--collect-only']],
    ['pytest', ['--co', '-q']],
    ['python', ['-m', 'pytest', '--version']],
    ['pytest', ['-V']],
    ['vitest', ['--help']],
    ['jest', ['-h']],
    ['cargo', ['test', '--no-run']],
    ['go', ['test', '-list', '.*']],
    ['go', ['test', '-n', './...']],
    ['dotnet', ['test', '--list-tests']],
    ['make', ['--just-print', 'test']],
    ['make', ['-q', 'test']],
    ['mvn', ['test', '-DskipTests']],
    ['gradle', ['test', '-m']],
    ['pnpm', ['exec', 'vitest', '--version']],
  ])('%s %j is not a test run', (cmd, args) => expect(isTestCommand(cmd, args)).toBe(false));

  it.each([
    ['pytest', ['-n', '4']],
    ['go', ['test', '-v', './...']],
    ['cargo', ['+nightly', 'test']],
    ['make', ['-C', 'build', 'test']],
    ['mvn', ['-q', 'clean', 'test']],
    ['npx', ['vitest', 'run', 'src/list.test.ts']],
  ])('%s %j still is', (cmd, args) => expect(isTestCommand(cmd, args)).toBe(true));
});

const whole = (text: string) => ({ preview: text, chars: text.length });
const cut = (text: string) => ({ preview: `${text}…`, chars: 5000, sha256: 'ab' });

describe('testRunOutcome needs evidence that a test ran (P4-F10)', () => {
  it('passes only when the whole output shows at least one passing test', () => {
    const pass = (text: string) => testRunOutcome({ exitCode: 0, result: whole(text) });
    expect(pass('exit code 0\n Tests  \u001b[32m3 passed\u001b[39m (3)')).toBe(true);
    expect(pass('exit code 0\n===== 12 passed in 0.31s =====')).toBe(true);
    expect(pass('exit code 0\nok  \tgithub.com/x/y\t0.012s')).toBe(true);
    expect(pass('exit code 0\n  4 passing (20ms)')).toBe(true);
    expect(pass('exit code 0\n# pass 2\n# fail 0')).toBe(true);
    expect(pass('exit code 0\nRan 5 tests in 0.002s\n\nOK')).toBe(true);
    // A clean exit that shows no test ran proves nothing.
    expect(pass('exit code 0\n Tests  0 passed (0)')).toBeUndefined();
    expect(pass('exit code 0\nNo test files found, exiting with code 0')).toBeUndefined();
    expect(pass('exit code 0\n?   \tgithub.com/x/y\t[no test files]')).toBeUndefined();
    expect(pass('exit code 0\nvitest/3.2.4 linux-x64 node-v22')).toBeUndefined();
    expect(pass('exit code 0')).toBeUndefined();
  });

  it('a failure fails, unless it only says no test was found', () => {
    expect(testRunOutcome({ exitCode: 1, result: whole('1 failed | 2 passed') })).toBe(false);
    expect(testRunOutcome({ exitCode: 2, result: whole('error TS2304') })).toBe(false);
    expect(
      testRunOutcome({ exitCode: 1, result: whole('No test files found, exiting with code 1') }),
    ).toBeUndefined();
    expect(testRunOutcome({ exitCode: 5, result: whole('collected 0 items') })).toBeUndefined();
  });

  it('falls back to the exit code when the output is cut or missing', () => {
    expect(testRunOutcome({ exitCode: 0, result: cut(' RUN  v3.2.4 /repo\n ✓ a.test.ts') })).toBe(
      true,
    );
    expect(testRunOutcome({ exitCode: 0 })).toBe(true);
    expect(testRunOutcome({ exitCode: 1, result: cut('FAIL a.test.ts') })).toBe(false);
    expect(testRunOutcome({ exitCode: 0, result: cut('No tests found, exiting') })).toBeUndefined();
    expect(testRunOutcome({ exitCode: null })).toBeUndefined();
    expect(testRunOutcome({ exitCode: 0, aborted: true })).toBeUndefined();
    expect(testRunOutcome({ exitCode: null, timedOut: true })).toBe(false);
  });
});

describe('the tests signal of a graded node (P4-F10)', () => {
  const shell = (args: string[], exitCode: number, text: string) => ({
    tool: 'shell.run',
    decision: 'confirmed',
    isError: exitCode !== 0,
    input: { command: 'npx', args },
    meta: { exitCode, timedOut: false, aborted: false },
    result: whole(`exit code ${exitCode}\n${text}`),
  });

  it('a no-op test command or an empty run earns no "tests passed"', () => {
    const s = new Script();
    s.plan([{ id: 'n1', type: 'test' }]);
    s.answer('n1', 'a/m', 'author', 'tests written', { taskType: 'test' });
    s.tool('n1', 'a/m', shell(['vitest', 'run'], 1, ' Tests  1 failed (1)'));
    s.tool('n1', 'a/m', shell(['vitest', 'run', '--passWithNoTests', 'nope'], 0, 'No test files'));
    s.tool('n1', 'a/m', shell(['vitest', 'run', 'nope'], 0, ' Tests  0 passed (0)'));
    s.outcome('run-1');
    const g = gradeJournal(s.j).grades.find((x) => x.nodeId === 'n1');
    // The real, failing run stays the node's last test evidence.
    expect(g?.signals).toEqual([expect.objectContaining({ kind: 'tests', value: 0 })]);
  });

  it('a run with tests passing counts', () => {
    const s = new Script();
    s.plan([{ id: 'n1', type: 'test' }]);
    s.answer('n1', 'a/m', 'author', 'tests written', { taskType: 'test' });
    s.tool('n1', 'a/m', shell(['vitest', 'run'], 0, ' Tests  2 passed (2)'));
    s.outcome('run-1');
    const g = gradeJournal(s.j).grades.find((x) => x.nodeId === 'n1');
    expect(g?.signals).toEqual([expect.objectContaining({ kind: 'tests', value: 1 })]);
  });
});
