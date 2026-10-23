/** `kpai grade`, `kpai bench`, `kpai stats` learning tables, terminal disputes. Offline. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verificationLine } from './commands/graph.js';
import { terminalChoose } from './host.js';
import { main } from './main.js';
import { fakeIo, type FakeIo } from './test-helpers/fake-io.js';
import { writeMockProviders } from './test-helpers/mock-providers.js';

const REQ = 'add an OAuth state validator with tests [[diff:src/s.ts]] [[testdiff:test/s.test.ts]]';

function setup(): FakeIo {
  const repo = mkdtempSync(join(tmpdir(), 'kpai-learn-cli-'));
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const io = fakeIo({ KPAI_CONFIRM_ABOVE_USD: '100' });
  io.cwd = repo;
  writeMockProviders(io.home, [
    { id: 'mock-alpha', price: [3, 15], code: 0.6, writing: 0.6, analysis: 0.95 },
    { id: 'mock-beta', price: [2, 10], code: 0.95, writing: 0.6 },
    { id: 'mock-gamma', price: [1, 5], code: 0.6, writing: 0.6, test: 0.95 },
    { id: 'mock-delta', price: [2, 10], code: 0.6, writing: 0.6, critique: 0.95 },
  ]);
  return io;
}

async function kpai(io: FakeIo, ...args: string[]): Promise<number> {
  io.stdout = '';
  io.stderr = '';
  return main(args, io);
}

describe('kpai grade, stats and bench', () => {
  it('grades a node and shows accuracy and measured competence in stats', async () => {
    const io = setup();
    expect(await kpai(io, 'do', '--allow-test', '--yes', REQ)).toBe(0);
    expect(io.stderr).toMatch(/^accuracy past estimates here: no finished run yet/m);
    expect(io.stderr).toMatch(/review \S+ \(\d+%\) for \d+ accepted finding/);
    const runId = /kpai merge (\S+)/.exec(io.stderr)?.[1] ?? '';
    const sessions = await kpai(io, 'log');
    expect(sessions).toBe(0);
    const run = runId || (await firstRunId(io));
    expect(await kpai(io, 'grade', run, 'implementation', 'good', 'clean', '--author', 'ana')).toBe(
      0,
    );
    expect(io.stdout).toMatch(/^graded good: node implementation of run \S+, by mock-/);
    expect(await kpai(io, 'grade', run, 'implementation', 'meh')).toBe(2);
    expect(await kpai(io, 'grade', run)).toBe(2);
    expect(await kpai(io, 'grade', run, 'nope', 'bad')).toBe(1);
    expect(await kpai(io, 'stats')).toBe(0);
    expect(io.stdout).toMatch(/^estimate accuracy here/m);
    expect(io.stdout).toMatch(/^ {2}run +1 {2}in band/m);
    expect(io.stdout).toMatch(/^measured competence here$/m);
    expect(io.stdout).toMatch(/approved \d+\/\d+ .* tasks here/);
  });

  it('asks before the bench and runs nothing on no', async () => {
    const io = setup();
    writeFileSync(
      join(io.cwd, 'calc.ts'),
      'export function add(a: number, b: number): number {\n  const s = a + b;\n  return s > 3 ? s : s + 1;\n}\n'.repeat(
        3,
      ),
    );
    expect(await kpai(io, 'bench', '--allow-test', '--per-kind', '1')).toBe(4);
    expect(io.questions.at(-1) ?? '').toMatch(/^Bench: |^$/);
    expect(io.stdout).toMatch(/bench: (declined, nothing was run|no task could be planned)/);
  });
});

/** The run id of the last `run outcome` in the journal (via `kpai log`). */
async function firstRunId(io: FakeIo): Promise<string> {
  await kpai(io, 'log');
  const session = io.stdout.split('\n')[0]!.slice(0, 8);
  await kpai(io, 'log', '--session', session);
  return /"runId":"([0-9a-f-]{36})"/.exec(io.stdout)?.[1] ?? '';
}

describe('disputes at the terminal (R-405)', () => {
  const dispute = {
    nodeId: 'n',
    kind: 'vote',
    reason: 'no majority',
    options: [
      { id: 'a', label: 'A', text: 'first\u001b[2J line', backers: ['p/m'] },
      { id: 'b', label: 'B', text: 'x'.repeat(3000), backers: [] },
    ],
    positions: [{ ref: 'p/m', role: 'voter', says: 'A', option: 'a' }],
  };
  const req = { kind: 'dispute' as const, question: 'pick', dispute };

  it('quotes the options safely and takes the first yes', async () => {
    const io = setup();
    io.confirmAnswers = [false, true];
    expect(await terminalChoose(io)(req)).toBe('b');
    expect(io.stderr).toContain('    > first');
    expect(io.stderr).not.toContain('\u001b');
    expect(io.stderr).toContain('…');
    expect(io.questions).toEqual(['Take option A for node n?', 'Take option B for node n?']);
  });

  it('rejects when every answer is no', async () => {
    const io = setup();
    expect(await terminalChoose(io)(req)).toBeNull();
    expect(io.stderr).toMatch(/dispute rejected: the node delivers nothing/);
  });

  it('summarizes review spend only when there was some', () => {
    const m = { currency: 'USD', rate: 1 };
    expect(verificationLine({}, m)).toBe('');
    expect(
      verificationLine(
        {
          verification: {
            reviewUsd: 0.5,
            share: 0.25,
            acceptedFindings: 2,
            usdPerAcceptedFinding: 0.25,
          },
        },
        m,
      ),
    ).toBe('review $0.50 (25%) for 2 accepted finding(s), $0.25 each');
  });
});
