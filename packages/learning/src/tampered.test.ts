/**
 * P5-F4 (D-035): a test run after the run changed its own test configuration (package.json
 * `scripts`, `.kpstudio/test.json`, a runner config or the script the test command names)
 * is journaled `tampered` by `test.run` and `shell.run`. It is no test evidence: no tests
 * signal for grades, nothing for V2 or DVO (all read `nodeWork().tests`).
 */
import { describe, expect, it } from 'vitest';
import { gradeJournal } from './grades.js';
import { northStar } from './north-star.js';
import { intent } from './test-helpers/north-star.js';
import { Script } from './test-helpers/script.js';

const testRun = (tampered?: boolean) => ({
  tool: 'test.run',
  decision: 'confirmed',
  isError: false,
  meta: {
    command: 'npm',
    args: ['test'],
    status: 'passed',
    ...(tampered === undefined ? {} : { tampered }),
  },
});
const shellRun = (meta: Record<string, unknown>) => ({
  tool: 'shell.run',
  decision: 'confirmed',
  isError: false,
  input: { command: 'npm', args: ['test'] },
  meta: { exitCode: 0, timedOut: false, aborted: false, ...meta },
});

function signals(...calls: Array<Record<string, unknown>>) {
  const s = new Script();
  s.plan([{ id: 'n1', type: 'test' }]);
  s.answer('n1', 'a/m', 'author', 'tests written', { taskType: 'test' });
  for (const c of calls) s.tool('n1', 'a/m', c);
  s.outcome('run-1');
  const g = gradeJournal(s.j).grades.find((x) => x.nodeId === 'n1');
  return (g?.signals ?? []).filter((x) => x.kind === 'tests').map((x) => x.value);
}

describe('tampered test runs are no evidence (P5-F4)', () => {
  it('an untampered test.run or shell test run counts', () => {
    expect(signals(testRun(false))).toEqual([1]);
    expect(signals(testRun())).toEqual([1]); // journals from before the check
    expect(signals(shellRun({}))).toEqual([1]);
  });

  it('a tampered test.run or shell test run is not a test signal', () => {
    expect(signals(testRun(true))).toEqual([]);
    expect(signals(shellRun({ tampered: true, tamperedFiles: ['package.json'] }))).toEqual([]);
  });

  it('an unchecked configuration (no git) proves a failure but never a pass (D-035)', () => {
    const unchecked = (status: string) => ({
      ...testRun(),
      meta: { ...testRun().meta, status, configChecked: false },
    });
    expect(signals(unchecked('passed'))).toEqual([]);
    expect(signals(unchecked('failed'))).toEqual([0]);
    expect(signals(shellRun({ configChecked: false }))).toEqual([]);
    expect(signals(shellRun({ configChecked: false, exitCode: 1 }))).toEqual([0]);
  });

  it('a tampered pass after a real failure leaves the failure standing', () => {
    expect(
      signals({ ...testRun(false), meta: { ...testRun().meta, status: 'failed' } }, testRun(true)),
    ).toEqual([0]);
  });
});

describe('the NORTH-STAR gaming move (P5-F4)', () => {
  /** A code run another provider approved, whose only test run is `test.run` (as given). */
  function delivered(tampered: boolean) {
    const s = new Script();
    s.plan([{ id: 'n1', type: 'code_generation' }], { expectedUsd: 0.1, capUsd: 0.3 });
    intent(s, 'r1', 'a');
    s.note({ action: 'run started', runId: 'r1' });
    s.answer('n1', 'alpha/m', 'author', 'diff', { costUsd: 0.1 });
    s.critic('n1', 'delta/m', true);
    s.tool('n1', 'alpha/m', testRun(tampered));
    s.outcome('r1');
    s.apply('r1', 'n1', 0, 'confirmed', false, ['src/x.ts']);
    const later = new Date(Date.parse('2026-10-23T10:00:00Z') + 30 * 86_400_000);
    return northStar(s.j, { project: '/repo', verify: false, now: later });
  }

  it('an echo test script the run wrote itself earns no V2 and no DVO', () => {
    expect(delivered(false)).toMatchObject({ dvo: 1, mix: { V2: 1 } });
    const n = delivered(true);
    expect(n.dvo).toBe(0);
    expect(n.deliverables.map((d) => d.assurance)).toEqual(['V1']);
  });
});
