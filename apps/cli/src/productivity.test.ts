/**
 * `kpai stats --productivity` (R-406) in English and French, `kpai bench --yes` without a
 * terminal, and `kpai replay` / `kpai fork` (R-403) through the kernel. Offline.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { duration } from './commands/productivity.js';
import { nodeEdit } from './commands/replay.js';
import { setLocale } from './i18n/core.js';
import { main } from './main.js';
import { fakeIo, type FakeIo } from './test-helpers/fake-io.js';
import { writeMockProviders } from './test-helpers/mock-providers.js';

const REQ = 'add an OAuth state validator with tests [[diff:src/s.ts]] [[testdiff:test/s.test.ts]]';

afterEach(() => setLocale('en'));

function setup(env: Record<string, string> = {}): FakeIo {
  const repo = mkdtempSync(join(tmpdir(), 'kpai-prod-cli-'));
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const io = fakeIo({ KPAI_CONFIRM_ABOVE_USD: '100', ...env });
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

/** The run id of the last run (its `run outcome`, via `kpai log`). */
async function lastRunId(io: FakeIo): Promise<string> {
  await kpai(io, 'log');
  const session = io.stdout.split('\n')[0]!.slice(0, 8);
  await kpai(io, 'log', '--session', session, '--limit', '1000');
  const ids = [...io.stdout.matchAll(/"action":"run outcome"[^\n]*?"runId":"([0-9a-f-]{36})"/g)];
  return ids.at(-1)?.[1] ?? '';
}

describe('kpai stats --productivity', () => {
  it('prints the block after accuracy; plain stats is unchanged', async () => {
    const io = setup();
    expect(await kpai(io, 'do', '--allow-test', '--yes', '--apply', '--yes-apply', REQ)).toBe(0);
    expect(await kpai(io, 'stats')).toBe(0);
    const plain = io.stdout;
    expect(plain).not.toMatch(/productivity here/);
    expect(await kpai(io, 'stats', '--productivity')).toBe(0);
    const out = io.stdout;
    expect(out.indexOf('estimate accuracy here')).toBeLessThan(out.indexOf('productivity here'));
    expect(out.indexOf('productivity here')).toBeLessThan(out.indexOf('measured competence'));
    expect(out).toMatch(/changes: 2 accepted · 0 declined · 0 failed · 0 pending · 0 discarded/);
    expect(out).toMatch(/per accepted change: \$[\d.]+ · \d/);
    expect(out).toMatch(/rolled back 0 \(0%\) · reworked 0 \(0%\) within 7 day\(s\)/);
    expect(out).toMatch(/billed cost inside the approved band: \d\/1 finished run\(s\)/);
    expect(out.replace(/productivity here[\s\S]*?(?=measured competence)/, '')).toBe(plain);

    expect(await kpai(io, 'stats', '--productivity', '--since', '2999-01-01T00:00:00Z')).toBe(0);
    expect(io.stdout).toMatch(/runs started since 2999-01-01T00:00:00.000Z/);
    expect(io.stdout).toMatch(/per accepted change: – \(no accepted change yet\)/);
    expect(await kpai(io, 'stats', '--productivity', '--since', 'soon')).toBe(2);
    expect(io.stderr).toMatch(/kpai stats --productivity: since is not a date/);
  });

  it('speaks French', async () => {
    const io = setup({ KPAI_LANG: 'fr' });
    expect(await kpai(io, 'stats', '--productivity')).toBe(0);
    expect(io.stdout).toMatch(/productivité ici \(d’après le journal seul/);
    expect(io.stdout).toMatch(/0 exécution\(s\) · dépensé \$0\.00 · durée 0s/);
    expect(io.stdout).toMatch(/par modification acceptée : – \(aucune modification/);
  });

  it('formats durations', () => {
    expect(duration(400)).toBe('0s');
    expect(duration(45_000)).toBe('45s');
    expect(duration(200_000)).toBe('3m 20s');
    expect(duration(7_500_000)).toBe('2h 05m');
  });
});

describe('kpai bench --yes', () => {
  it('runs unattended: --yes accepts the bench cost question', async () => {
    const io = setup();
    const fn = (n: number) =>
      `export function f${n}(a: number, b: number): number {\n  const x = a * ${n} + b;\n  return x > 10 ? x - 10 : x + 1;\n}\n`;
    spawnSync('mkdir', ['-p', join(io.cwd, 'src')]);
    writeFileSync(join(io.cwd, 'src/calc.ts'), [1, 2, 3].map(fn).join('\n'));
    expect(await kpai(io, 'bench', '--allow-test', '--yes', '--per-kind', '1')).toBe(0);
    expect(io.questions.filter((q) => /^Bench: /.test(q))).toEqual([]);
    expect(io.stderr).toMatch(/^Bench: .* yes \(--yes accepts cost questions\)$/m);
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: io.cwd }).stdout.toString();
    expect(status).toBe('?? src/\n');
  });
});

describe('kpai replay and kpai fork (R-403)', () => {
  it('replays a node beside the original, then forks from a node', async () => {
    const io = setup();
    expect(await kpai(io, 'do', '--allow-test', '--yes', REQ)).toBe(0);
    const run = await lastRunId(io);
    expect(run).not.toBe('');
    // P4-F5: likely and cap first; without --yes or a y nothing is spent.
    const replay = ['replay', run, 'implementation', '-m', 'mock-alpha/m1', '--allow-test'];
    expect(await kpai(io, ...replay)).toBe(4);
    expect(io.stderr).toMatch(
      /replay of implementation \(run \S{8}\): likely .* · up to .* \(cap\)/,
    );
    expect(io.questions.at(-1)).toMatch(/^Run this replay of implementation .* for up to /);
    expect(io.stderr).toMatch(/not run — replay declined/);
    expect(io.stdout).not.toMatch(/--- replay:/);
    io.confirmAnswers = [true];
    expect(await kpai(io, ...replay)).toBe(0);
    expect(io.stdout).toMatch(/^--- original: author_critic · /m);
    expect(io.stdout).toMatch(/^--- replay: author_critic · mock-alpha\/m1/m);
    expect(io.stderr).toMatch(/^replay \S{8} of implementation: (same|different) output · cost /m);
    expect(
      await kpai(io, 'replay', run, 'implementation', '-m', 'nope/x', '--allow-test', '--yes'),
    ).toBe(2);
    expect(io.stderr).toMatch(/not run — model nope\/x is not available/);
    // P4-F2: routing flags reach the kernel (no local provider here: nothing can route).
    expect(
      await kpai(io, 'replay', run, 'implementation', '--allow-test', '--yes', '--local-only'),
    ).toBe(1);
    expect(io.stderr).toMatch(/not run — .*cannot be routed|unroutable|no candidate/i);
    const all = 'mock-alpha,mock-beta,mock-gamma,mock-delta';
    expect(await kpai(io, 'fork', run, 'tests', '--allow-test', '--yes', '--exclude', all)).toBe(1);
    expect(await kpai(io, 'replay', run, 'nope', '--allow-test')).toBe(1);
    expect(await kpai(io, 'replay', run, 'tests', '--instruction', 'x')).toBe(2);
    expect(await kpai(io, 'replay', run)).toBe(2);

    const fork = ['fork', run, 'tests', '--instruction', 'cover the empty state'];
    expect(await kpai(io, ...fork, '--allow-test', '--yes')).toBe(0);
    expect(io.stderr).toMatch(
      /fork of \S{8}: rerun tests, review · reused architecture, implementation/,
    );
    expect(io.stderr).toMatch(/patch\(es\) shown, not applied \(use --apply\)|no patch/);
    expect(await kpai(io, 'fork', 'no-such-run', 'tests', '--allow-test')).toBe(1);
  });

  it('parses the edit', () => {
    const base = { runId: 'r', nodeId: 'n' };
    expect(nodeEdit({ ...base, model: 'p/m/x', protocol: 'vote', instruction: ' go ' })).toEqual({
      model: { provider: 'p', model: 'm/x' },
      protocol: 'vote',
      instruction: 'go',
    });
    expect(() => nodeEdit({ ...base, model: 'pm' })).toThrow(/provider\/model/);
    expect(() => nodeEdit({ ...base, model: 'p/' })).toThrow(/provider\/model/);
    expect(() => nodeEdit({ ...base, protocol: 'chaos' })).toThrow(/--protocol/);
    expect(nodeEdit({ ...base, instruction: '  ' })).toEqual({});
  });
});
