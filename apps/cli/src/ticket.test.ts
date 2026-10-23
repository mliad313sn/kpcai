import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from './main.js';
import { fakeIo, type FakeIo } from './test-helpers/fake-io.js';
import { writeMockProviders } from './test-helpers/mock-providers.js';

const TICKET = [
  '---',
  'title: OAuth state validator',
  'status: open',
  'skill: tdd',
  '---',
  'add an OAuth state validator with tests [[diff:src/s.ts]] [[testdiff:test/s.test.ts]]',
  '\u001b]52;c;cGF5bG9hZA==\u0007',
  '## Acceptance criteria',
  '- state is checked',
  '',
].join('\n');

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function setup(): FakeIo {
  const repo = mkdtempSync(join(tmpdir(), 'kpai-ticket-'));
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
  put(repo, '.kpstudio/tickets/T-1.md', TICKET);
  put(
    repo,
    '.kpstudio/skills/tdd/SKILL.md',
    '---\nname: tdd\ndescription: tests first\nallowed-tools: Read\n---\nRed, green, refactor.\n',
  );
  return io;
}

describe('kpai ticket', () => {
  it('lists and shows tickets, sanitized', async () => {
    const io = setup();
    expect(await main(['ticket', 'list'], io)).toBe(0);
    expect(io.stdout).toMatch(/T-1\s+open\s+OAuth state validator\s+\(skill tdd\)/);
    expect(await main(['ticket', 'show', 'T-1'], io)).toBe(0);
    expect(io.stdout).toMatch(/UNTRUSTED text from \.kpstudio\/tickets\/T-1\.md/);
    expect(io.stdout).toMatch(/1\. state is checked/);
    expect(io.stdout).not.toContain('\u001b');
    expect(await main(['ticket'], io)).toBe(2);
    expect(await main(['ticket', 'show', 'nope'], io)).toBe(1);
  });

  it('runs a ticket and writes its status only on a yes', async () => {
    const io = setup();
    const file = join(io.cwd, '.kpstudio/tickets/T-1.md');
    io.confirmAnswers.push(false);
    expect(await main(['ticket', 'run', 'T-1', '--allow-test'], io)).toBe(0);
    expect(io.stderr).toMatch(/ticket T-1: status open → done/);
    expect(io.stderr).toMatch(/ticket T-1 unchanged/);
    expect(readFileSync(file, 'utf8')).toBe(TICKET);
    io.confirmAnswers.push(true);
    expect(await main(['ticket', 'run', 'T-1', '--allow-test'], io)).toBe(0);
    expect(io.stderr).toMatch(/ticket T-1 is now done/);
    expect(readFileSync(file, 'utf8')).toBe(TICKET.replace('status: open', 'status: done'));
  });
});

describe('kpai extensions', () => {
  it('lists skills, agents and hooks with their origin', async () => {
    const io = setup();
    put(
      io.cwd,
      '.claude/agents/sec.md',
      '---\nname: sec\ndescription: security\nmodel: x\n---\nb\n',
    );
    put(
      io.cwd,
      '.kpstudio/hooks.json',
      JSON.stringify({
        hooks: [{ name: 'g', event: 'before-tool', command: 'node', args: ['g.mjs'] }],
      }),
    );
    put(io.cwd, '.claude/skills/bad/SKILL.md', '---\nname: bad\n---\n');
    expect(await main(['extensions'], io)).toBe(0);
    expect(io.stdout).toMatch(/skill {2}tdd \(repo, untrusted\): tests first · tools fs\.read/);
    expect(io.stdout).toMatch(/agent {2}sec \(repo, untrusted\): security · model hint x/);
    expect(io.stdout).toMatch(/hook {3}g before-tool \(repo, untrusted, confirmed each time\)/);
    expect(io.stderr).toMatch(/needs a description/);
    const empty = fakeIo();
    empty.cwd = mkdtempSync(join(tmpdir(), 'kpai-empty-'));
    expect(await main(['extensions'], empty)).toBe(0);
    expect(empty.stdout).toBe('no skills, agents or hooks\n');
  });

  it('plans with --skill and refuses an unknown one', async () => {
    const io = setup();
    const req = 'add an OAuth state validator with tests';
    expect(await main(['plan', req, '--allow-test', '--skill', 'tdd'], io)).toBe(0);
    expect(await main(['plan', req, '--allow-test', '--agent', 'ghost'], io)).toBe(1);
    expect(io.stderr).toMatch(/unknown agent "ghost"/);
  });
});
