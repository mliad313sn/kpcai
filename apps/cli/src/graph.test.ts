import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from './main.js';
import { fakeIo, type FakeIo } from './test-helpers/fake-io.js';
import { writeMockProviders } from './test-helpers/mock-providers.js';

const REQ = 'add an OAuth state validator with tests [[diff:src/s.ts]] [[testdiff:test/s.test.ts]]';

/** A git repo + four mock providers, each best at a different task type. */
function setup(env: Record<string, string> = {}): FakeIo {
  const repo = mkdtempSync(join(tmpdir(), 'kpai-graph-'));
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const io = fakeIo(env);
  io.cwd = repo;
  writeMockProviders(io.home, [
    { id: 'mock-alpha', price: [3, 15], code: 0.6, writing: 0.6, analysis: 0.95 },
    { id: 'mock-beta', price: [2, 10], code: 0.95, writing: 0.6 },
    { id: 'mock-gamma', price: [1, 5], code: 0.6, writing: 0.6, test: 0.95 },
    { id: 'mock-delta', price: [2, 10], code: 0.6, writing: 0.6, critique: 0.95 },
  ]);
  return io;
}

describe('kpai tools / plan / do', () => {
  it('lists tools with their risk', async () => {
    const io = setup();
    expect(await main(['tools'], io)).toBe(0);
    expect(io.stdout).toMatch(/fs\.read\s+read\s+builtin/);
    expect(io.stdout).toMatch(/shell\.run\s+destructive/);
  });

  it('plans four nodes on four different models, with the cost before running', async () => {
    const io = setup();
    expect(await main(['plan', '--allow-test', REQ], io)).toBe(0);
    const models = [...io.stdout.matchAll(/(mock-\w+)\/m1/g)].map((m) => m[1]);
    expect(new Set(models).size).toBe(4);
    expect(io.stdout).toMatch(/^total\s+\$[\d.]+–\$[\d.]+ before running/m);
  });

  it('runs the graph with cross-provider review and shows patches without applying', async () => {
    const io = setup();
    expect(await main(['do', '--allow-test', '--yes', REQ], io)).toBe(0);
    expect(io.stderr).toMatch(/implementation review by mock-\w+\/m1 \(critic\)/);
    expect(io.stderr).toMatch(/2 patch\(es\) shown, not applied/);
    expect(io.stdout).toMatch(/implementation — Implementation \[done · approved\]/);
    expect(existsSync(join(io.cwd, 'src/s.ts'))).toBe(false);
  });

  it('applies approved patches with --apply', async () => {
    const io = setup();
    expect(await main(['do', '--allow-test', '--yes', '--apply', '--yes-apply', REQ], io)).toBe(0);
    expect(io.stderr).toMatch(/2\/2 patch\(es\) applied/);
    expect(existsSync(join(io.cwd, 'src/s.ts'))).toBe(true);
    expect(existsSync(join(io.cwd, 'test/s.test.ts'))).toBe(true);
  });

  it('refuses self-review with one provider unless waived (principle 2)', async () => {
    const only = ['--exclude', 'mock,mock-alpha,mock-beta,mock-gamma'];
    const io = setup();
    expect(await main(['do', '--allow-test', ...only, 'draft an email announcing v2'], io)).toBe(1);
    expect(io.stdout).toMatch(/\[failed\]/);
    const waived = setup();
    expect(
      await main(
        ['do', '--allow-test', '--allow-same-provider', ...only, 'draft an email announcing v2'],
        waived,
      ),
    ).toBe(0);
  });

  it('checks the whole graph against the budget before running', async () => {
    const io = setup({ KPAI_BUDGET_SESSION_USD: '0.0001' });
    expect(await main(['do', '--allow-test', '--yes', REQ], io)).toBe(4);
    expect(io.stderr).toMatch(/graph blocked by session budget/);
    const over = setup({ KPAI_BUDGET_SESSION_USD: '0.0001' });
    expect(await main(['do', '--allow-test', '--over-budget', REQ], over)).toBe(0);
  });

  it('asks before running above the confirmation threshold', async () => {
    const io = setup({ KPAI_CONFIRM_ABOVE_USD: '0' });
    expect(await main(['do', '--allow-test', REQ], io)).toBe(4);
    expect(io.questions[0]).toMatch(/confirmation threshold/);
    expect(await main(['plan', '--allow-test', '--planner', 'nope', REQ], io)).toBe(2);
    expect(await main(['do'], io)).toBe(2);
  });

  it('--yes alone never approves the write (review P2-F15)', async () => {
    const io = setup();
    expect(await main(['do', '--allow-test', '--yes', '--apply', REQ], io)).toBe(0);
    expect(io.questions.some((q) => /git\.apply/.test(q))).toBe(true);
    expect(existsSync(join(io.cwd, 'src/s.ts'))).toBe(false);
  });
});
