/** Review P3-F1 through the CLI: `kpai do --apply` asks once per patch, even from one node. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from './main.js';
import { fakeIo, type FakeIo } from './test-helpers/fake-io.js';
import { writeMockProviders } from './test-helpers/mock-providers.js';

function creation(file: string, line: string): string {
  return [
    '```diff',
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    `+${line}`,
    '```',
  ].join('\n');
}

/** The mock author echoes the request: its reply holds both diffs. */
const TWO = [
  'add an OAuth state validator with tests',
  creation('a.txt', 'A'),
  creation('b.txt', 'B'),
  '',
].join('\n');

function setup(): FakeIo {
  const repo = mkdtempSync(join(tmpdir(), 'kpai-apply-'));
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const io = fakeIo();
  io.cwd = repo;
  writeMockProviders(io.home, [
    { id: 'mock-alpha', price: [3, 15], code: 0.6, writing: 0.6, analysis: 0.95 },
    { id: 'mock-beta', price: [2, 10], code: 0.95, writing: 0.6 },
    { id: 'mock-gamma', price: [1, 5], code: 0.6, writing: 0.6, test: 0.95 },
    { id: 'mock-delta', price: [2, 10], code: 0.6, writing: 0.6, critique: 0.95 },
  ]);
  return io;
}

describe('kpai do --apply (review P3-F1)', () => {
  it('asks once per patch of one node; a no to the second leaves its file unwritten', async () => {
    const io = setup();
    io.confirmAnswers = [true, false];
    expect(await main(['do', '--allow-test', '--yes', '--apply', TWO], io)).toBe(0);
    const writes = io.questions.filter((q) => /git\.apply/.test(q));
    expect(writes).toHaveLength(2);
    expect(existsSync(join(io.cwd, 'a.txt'))).toBe(true);
    expect(existsSync(join(io.cwd, 'b.txt'))).toBe(false);
  });
});
