import { describe, expect, it } from 'vitest';
import { gradeJournal, type NodeGrade } from './grades.js';
import { localAuthor, recordGrade } from './manual.js';
import { SIGNAL_WEIGHTS, isTestCommand } from './signals.js';
import { Script } from './test-helpers/script.js';

/** Journal meta of a `test.run` call (tools/builtins/test-run.ts). */
const run = (status: string, args = ['vitest', 'run']) => ({ command: 'npx', args, status });

const of = (grades: NodeGrade[], model: string, nodeId = 'n1'): NodeGrade | undefined =>
  grades.find((g) => `${g.ref.provider}/${g.ref.model}` === model && g.nodeId === nodeId);

describe('automatic grades from scripted journals', () => {
  it('grades the author 1 on approval and 0 on rejection, per task type and project', () => {
    const s = new Script('/repo');
    s.authorCritic('run-a', { author: 'a/m', critic: 'b/m', approve: true });
    s.authorCritic('run-b', { author: 'a/m', critic: 'b/m', approve: false });
    const { grades } = gradeJournal(s.j);
    expect(grades.map((g) => [g.runKey, g.grade, g.taskType, g.project])).toEqual([
      ['run-a', 1, 'test', '/repo'],
      ['run-b', 0, 'test', '/repo'],
    ]);
    // the critic itself is not graded by its own verdict
    expect(grades.every((g) => g.ref.provider === 'a')).toBe(true);
  });

  it('a revision approved after a rejection grades 0.5; a major issue is a rejection', () => {
    const s = new Script();
    s.plan([{ id: 'n1', type: 'code_generation' }]);
    s.answer('n1', 'a/m', 'author', 'v1');
    s.critic('n1', 'b/m', true, true); // approve: true with a major issue → rejected
    s.answer('n1', 'a/m', 'revision', 'v2');
    s.critic('n1', 'b/m', true);
    s.outcome('run-1');
    const g = of(gradeJournal(s.j).grades, 'a/m');
    expect(g?.grade).toBe(0.5);
    expect(g?.signals.map((x) => [x.kind, x.value])).toEqual([
      ['critic', 0],
      ['critic', 1],
    ]);
  });

  it('ignores a self-grading attempt: a critic reviewing its own draft', () => {
    const s = new Script();
    s.authorCritic('run-1', { author: 'a/m', critic: 'a/m', approve: true });
    const { grades, ignored } = gradeJournal(s.j);
    expect(grades).toEqual([]);
    expect(ignored).toEqual([expect.objectContaining({ runKey: 'run-1', reason: 'self-review' })]);
  });

  it('a same-provider critic (diversity waived) counts half', () => {
    const s = new Script();
    s.authorCritic('run-1', { author: 'a/m', critic: 'a/other', approve: true });
    const g = of(gradeJournal(s.j).grades, 'a/m');
    expect(g?.signals[0]?.weight).toBe(SIGNAL_WEIGHTS.critic / 2);
  });

  it('the last test run of the node counts; other commands and missing programs do not', () => {
    const s = new Script();
    s.plan([{ id: 'n1', type: 'test' }]);
    s.answer('n1', 'a/m', 'author', 'tests written', { taskType: 'test' });
    s.test('n1', 'a/m', 1);
    s.test('n1', 'a/m', 0, 'pnpm', ['test']);
    s.test('n1', 'a/m', 1, 'ls', ['-la']);
    s.test('n1', 'a/m', null, 'pytest', []);
    s.outcome('run-1');
    const g = of(gradeJournal(s.j).grades, 'a/m');
    expect(g?.signals).toEqual([expect.objectContaining({ kind: 'tests', value: 1 })]);
    expect(g?.grade).toBe(1);
  });

  it('grades patches: applied 1, declined 0, rolled back 0 at double weight', () => {
    const s = new Script();
    s.plan([
      { id: 'n1', type: 'code_generation' },
      { id: 'n2', type: 'code_generation' },
      { id: 'n3', type: 'code_generation' },
    ]);
    for (const n of ['n1', 'n2', 'n3']) s.answer(n, 'a/m', 'author', `patch ${n}`);
    s.outcome('run-1');
    s.apply('run-1', 'n1', 0);
    const cp2 = s.apply('run-1', 'n2', 0);
    s.apply('run-1', 'n3', 0, 'declined');
    s.restore('run-1', cp2); // undoes n2 (and what came after), not n1
    const { grades } = gradeJournal(s.j);
    const sig = (n: string) =>
      of(grades, 'a/m', n)?.signals.map((x) => [x.kind, x.value, x.weight]);
    expect(sig('n1')).toEqual([['patch', 1, 1]]);
    expect(sig('n2')).toEqual([['rollback', 0, 2]]);
    expect(sig('n3')).toEqual([['patch', 0, 1]]);
  });

  it('a restore of a checkpoint taken before the merge undoes every patch of the run', () => {
    const s = new Script();
    s.plan([{ id: 'n1', type: 'code_generation' }]);
    s.answer('n1', 'a/m', 'author', 'p');
    s.outcome('run-1');
    s.apply('run-1', 'n1', 0);
    s.note({
      action: 'checkpoint',
      runId: 'run-1',
      ref: 'refs/kpai/checkpoints/run-1/9',
      label: 'before merge',
    });
    s.restore('run-1', 'refs/kpai/checkpoints/run-1/9');
    expect(of(gradeJournal(s.j).grades, 'a/m')?.signals[0]?.kind).toBe('rollback');
  });

  it('a cancelled run is weak negative evidence; a refused patch is a failed patch', () => {
    const s = new Script();
    s.plan([{ id: 'n1', type: 'analysis' }]);
    s.answer('n1', 'a/m', 'solo', 'partial', { taskType: 'analysis' });
    s.note({ action: 'patch refused: control characters' }, 'n1');
    s.note({ action: 'cancel graph', runId: 'run-1' });
    s.outcome('run-1', 'finished', true);
    const g = of(gradeJournal(s.j).grades, 'a/m');
    expect(g?.signals.map((x) => [x.kind, x.weight])).toEqual([
      ['patch', 1],
      ['cancelled', 0.5],
    ]);
  });

  it('separates runs of one session and keeps their reused node ids apart', () => {
    const s = new Script();
    s.authorCritic('run-1', { author: 'a/m', critic: 'b/m', approve: true });
    s.authorCritic('run-2', { author: 'c/m', critic: 'b/m', approve: false });
    s.session('/other');
    s.authorCritic('run-3', { author: 'a/m', critic: 'b/m', approve: false });
    const { grades } = gradeJournal(s.j);
    expect(grades.map((g) => [g.runKey, `${g.ref.provider}`, g.grade, g.project])).toEqual([
      ['run-1', 'a', 1, '/repo'],
      ['run-2', 'c', 0, '/repo'],
      ['run-3', 'a', 0, '/other'],
    ]);
  });

  it('skips nodes without a task type and producers that never answered', () => {
    const s = new Script();
    s.answer('n1', 'a/m', 'voter', 'A');
    s.answer('n2', 'a/m', 'author', '', { taskType: 'test' });
    s.answer('n3', 'a/m', 'author', 'x', { taskType: 'test', stop: 'cancelled' });
    s.critic('n4', 'b/m', true); // a verdict with no draft before it
    expect(gradeJournal(s.j).grades).toEqual([]);
  });
});

describe('more outcomes', () => {
  it('a declined merge-back undoes the patches; a timeout fails tests; test.run counts', () => {
    const s = new Script();
    s.plan([
      { id: 'n1', type: 'code_generation' },
      { id: 'n2', type: 'test' },
    ]);
    s.answer('n1', 'a/m', 'author', 'p1');
    s.answer('n2', 'a/m', 'author', 't', { taskType: 'test' });
    s.tool('n1', 'a/m', {
      tool: 'shell.run',
      decision: 'confirmed',
      input: { command: 'vitest', args: [] },
      meta: { exitCode: null, timedOut: true },
    });
    s.tool('n2', 'a/m', {
      tool: 'test.run',
      decision: 'allow',
      isError: false,
      meta: run('passed'),
    });
    s.tool('n2', 'a/m', { tool: 'test.run', decision: 'deny', isError: true });
    s.outcome('run-1');
    s.apply('run-1', 'n1', 0);
    s.note({ action: 'merge-back declined', runId: 'run-1' });
    const { grades } = gradeJournal(s.j);
    expect(of(grades, 'a/m', 'n1')?.signals.map((x) => [x.kind, x.value])).toEqual([
      ['tests', 0],
      ['rollback', 0],
    ]);
    expect(of(grades, 'a/m', 'n2')?.signals.map((x) => [x.kind, x.value])).toEqual([['tests', 1]]);
  });
});

describe('test.run evidence (R-505)', () => {
  it('counts a real test command by its parsed status; no-op commands and no-test runs do not', () => {
    const s = new Script();
    s.plan([
      { id: 'n1', type: 'test' },
      { id: 'n2', type: 'test' },
      { id: 'n3', type: 'test' },
    ]);
    for (const n of ['n1', 'n2', 'n3']) s.answer(n, 'a/m', 'author', 't', { taskType: 'test' });
    s.tool('n1', 'a/m', { tool: 'test.run', decision: 'confirmed', meta: run('failed') });
    s.tool('n2', 'a/m', {
      tool: 'test.run',
      decision: 'confirmed',
      meta: run('passed', ['vitest', 'run', '--passWithNoTests']),
    });
    s.tool('n2', 'a/m', { tool: 'test.run', decision: 'confirmed', meta: run('no-tests') });
    s.tool('n2', 'a/m', {
      tool: 'test.run',
      decision: 'confirmed',
      meta: { ...run('passed'), command: 'make', args: ['lint'] },
    });
    s.tool('n3', 'a/m', {
      tool: 'test.run',
      decision: 'confirmed',
      meta: { ...run('error'), timedOut: true },
    });
    s.tool('n3', 'a/m', { tool: 'test.run', decision: 'confirmed', meta: null });
    s.outcome('run-1');
    const { grades } = gradeJournal(s.j);
    expect(of(grades, 'a/m', 'n1')?.signals.map((x) => [x.kind, x.value])).toEqual([['tests', 0]]);
    // No signal at all: n2 gets no grade.
    expect(of(grades, 'a/m', 'n2')?.signals ?? []).toEqual([]);
    expect(of(grades, 'a/m', 'n3')?.signals.map((x) => [x.kind, x.value])).toEqual([['tests', 0]]);
  });
});

describe('manual grades', () => {
  it('defaults the author to the local user', () => {
    expect(localAuthor()).toMatch(/\S/);
  });

  it('journals the author; only the latest grade of the node weighs (P4-F9)', () => {
    const s = new Script();
    s.authorCritic('run-123456', { author: 'a/m', critic: 'b/m', approve: true });
    const r = recordGrade(s.j, {
      run: 'run-12',
      nodeId: 'n1',
      grade: 'bad',
      author: 'alice',
      note: 'wrong\nfile',
    });
    expect(r.ref).toEqual({ provider: 'a', model: 'm' });
    expect(r.event.payload).toMatchObject({
      action: 'grade',
      author: 'alice',
      source: 'human',
      note: 'wrong file',
    });
    const alice = recordGrade(s.j, {
      run: 'run-123456',
      nodeId: 'n1',
      grade: 'good',
      author: 'alice',
    });
    recordGrade(s.j, { run: 'run-123456', nodeId: 'n1', grade: 'bad', author: 'bob' });
    const { grades, ignored } = gradeJournal(s.j);
    const g = of(grades, 'a/m');
    expect(g?.signals.filter((x) => x.kind === 'manual').map((x) => x.value)).toEqual([0]);
    // critic 1 (w 1) + bob's latest 0 (w 3) → 1/4
    expect(g?.grade).toBeCloseTo(1 / 4);
    expect(ignored).toEqual([
      { runKey: 'run-123456', nodeId: 'n1', seq: r.event.seq, reason: 'superseded' },
      { runKey: 'run-123456', nodeId: 'n1', seq: alice.event.seq, reason: 'superseded' },
    ]);
  });

  it('caps manual weight at one grade even under spoofed author names (P4-F9)', () => {
    const s = new Script();
    s.authorCritic('run-1', { author: 'a/m', critic: 'b/m', approve: false });
    // Grade events written past the server, each under a new name.
    const grade = { action: 'grade', runId: 'run-1', nodeId: 'n1', source: 'human' };
    for (let i = 0; i < 5; i++) s.note({ ...grade, grade: 'good', author: `fan-${i}` });
    const g = of(gradeJournal(s.j).grades, 'a/m');
    const manual = g?.signals.filter((x) => x.kind === 'manual') ?? [];
    expect(manual.map((x) => [x.value, x.weight])).toEqual([[1, SIGNAL_WEIGHTS.manual]]);
    // critic 0 (w 1) + one manual 1 (w 3) → 3/4, not 15/16.
    expect(g?.grade).toBeCloseTo(3 / 4);
    expect(gradeJournal(s.j).ignored.filter((i) => i.reason === 'superseded')).toHaveLength(4);
  });

  it('refuses a model grading its own work and unknown runs or nodes', () => {
    const s = new Script();
    s.authorCritic('run-1', { author: 'a/m', critic: 'b/m', approve: true });
    expect(() =>
      recordGrade(s.j, { run: 'run-1', nodeId: 'n1', grade: 'good', author: 'a/m' }),
    ).toThrow(/own work/);
    expect(() =>
      recordGrade(s.j, { run: 'nope-nope', nodeId: 'n1', grade: 'good', author: 'x' }),
    ).toThrow(/no run/);
    expect(() =>
      recordGrade(s.j, { run: 'run-1', nodeId: 'n9', grade: 'good', author: 'x' }),
    ).toThrow(/no answered node/);
    expect(() =>
      recordGrade(s.j, { run: 'run-1', nodeId: 'n1', grade: 'meh' as 'good', author: 'x' }),
    ).toThrow(/good/);
    expect(() =>
      recordGrade(s.j, { run: 'run-1', nodeId: 'n1', grade: 'good', author: ' ' }),
    ).toThrow(/author/);
  });

  it('ignores forged grade events: not human, or naming the graded model', () => {
    const s = new Script();
    s.authorCritic('run-1', { author: 'a/m', critic: 'b/m', approve: false });
    const grade = { action: 'grade', runId: 'run-1', nodeId: 'n1', grade: 'good' };
    s.note({ ...grade, author: 'a/m', source: 'model' });
    s.note({ ...grade, author: 'A/M', source: 'human' });
    s.note({ ...grade, author: 'm', source: 'human' });
    s.note({ ...grade, nodeId: 'n7', author: 'carol', source: 'human' });
    s.note({ action: 'bench check', runId: 'run-1', nodeId: 'n1', passed: true, source: 'model' });
    const { grades, ignored } = gradeJournal(s.j);
    expect(of(grades, 'a/m')?.grade).toBe(0);
    expect(ignored.map((i) => i.reason)).toEqual([
      'untrusted source',
      'self-grade',
      'self-grade',
      'unknown node',
      'untrusted source',
    ]);
  });

  it('grades a run without a run id (kpai ask) through its session id', () => {
    const s = new Script();
    s.answer('ask', 'a/m', undefined, 'an answer', { taskType: 'analysis' });
    const r = recordGrade(s.j, { run: s.sid, nodeId: 'ask', grade: 'good', author: 'alice' });
    expect(r.runKey.startsWith(`${s.sid}#`)).toBe(true);
    const g = of(gradeJournal(s.j).grades, 'a/m', 'ask');
    expect(g).toMatchObject({ grade: 1, taskType: 'analysis' });
  });
});

describe('isTestCommand', () => {
  it.each([
    ['vitest', ['run']],
    ['npx', ['vitest']],
    ['npm', ['test']],
    ['pnpm', ['run', 'test:unit']],
    ['pnpm', ['exec', 'jest']],
    ['python3', ['-m', 'pytest']],
    ['go', ['test', './...']],
    ['/usr/bin/cargo', ['test']],
    ['pytest.exe', []],
  ])('%s %j is a test run', (cmd, args) => expect(isTestCommand(cmd, args)).toBe(true));
  it.each([
    ['npm', ['install']],
    ['pnpm', ['run', 'build']],
    ['python', ['script.py']],
    ['go', ['build']],
    ['ls', []],
    ['npx', ['tsc']],
  ])('%s %j is not', (cmd, args) => expect(isTestCommand(cmd, args)).toBe(false));
});
