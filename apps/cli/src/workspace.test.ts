import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { main } from './main.js';
import { fakeIo, type FakeIo } from './test-helpers/fake-io.js';
import { writeMockProviders } from './test-helpers/mock-providers.js';

const REQ = 'add an OAuth state validator with tests [[diff:src/s.ts]] [[testdiff:test/s.test.ts]]';

function setup(): FakeIo {
  const repo = mkdtempSync(join(tmpdir(), 'kpai-ws-'));
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

const runIdOf = (io: FakeIo): string => /kpai merge (\S+)/.exec(io.stderr)?.[1] ?? '';

describe('kpai plan: repository rules (R-306)', () => {
  it('lists the rule files and the ones skipped in forbidden zones', async () => {
    const io = setup();
    writeFileSync(join(io.cwd, 'AGENTS.md'), 'rules\n');
    writeFileSync(join(io.cwd, '.cursorrules'), 'more\n');
    spawnSync('mkdir', ['-p', join(io.cwd, '.cursor/rules')]);
    writeFileSync(join(io.cwd, '.cursor/rules/my-secret.md'), 'x\n');
    expect(await main(['plan', '--allow-test', REQ], io)).toBe(0);
    expect(io.stdout).toMatch(
      /^rules {2}AGENTS\.md \(agents\) · \.cursorrules \(cursor\) — untrusted context for every node · 1 in forbidden zones skipped$/m,
    );
  });
});

describe('kpai do --isolated (R-307)', () => {
  it('merges the worktree after confirmation and removes it', async () => {
    const io = setup();
    io.confirmAnswers = [true];
    const args = ['do', '--allow-test', '--yes', '--apply', '--yes-apply', '--isolated', REQ];
    expect(await main(args, io)).toBe(0);
    expect(io.stderr).toMatch(/--- merge of run/);
    expect(io.stderr).toMatch(/merged 2 file\(s\) \(undo: kpai restore refs\/kpai\/checkpoints\//);
    expect(io.questions.at(-1)).toMatch(/worktree\.merge/);
    expect(existsSync(join(io.cwd, 'src/s.ts'))).toBe(true);
  });

  it('keeps the worktree without --apply; merge, discard and checkpoints work later', async () => {
    const io = setup();
    expect(await main(['do', '--allow-test', '--yes', '--isolated', REQ], io)).toBe(0);
    expect(io.stderr).toMatch(/worktree empty, removed/);

    const kept = setup();
    kept.confirmAnswers = [false];
    const args = ['do', '--allow-test', '--yes', '--apply', '--yes-apply', '--isolated', REQ];
    expect(await main(args, kept)).toBe(0);
    expect(kept.stderr).toMatch(/worktree kept: /);
    const runId = runIdOf(kept);
    expect(existsSync(join(kept.cwd, 'src/s.ts'))).toBe(false);

    kept.confirmAnswers = [true];
    expect(await main(['merge', runId], kept)).toBe(0);
    expect(kept.stdout).toMatch(/merged 2 file\(s\): src\/s\.ts, test\/s\.test\.ts/);
    expect(existsSync(join(kept.cwd, 'src/s.ts'))).toBe(true);
    // Merging twice is refused by the apply check: the files are already there.
    kept.confirmAnswers = [true];
    expect(await main(['merge', runId], kept)).toBe(1);
    expect(await main(['discard', runId], kept)).toBe(0);
    expect(kept.stdout).toMatch(/worktree of run .* removed/);
    expect(await main(['discard', runId], kept)).toBe(0);
    expect(kept.stdout).toMatch(/no worktree for run/);
    expect(await main(['merge', runId], kept)).toBe(1);
    expect(await main(['discard', 'bad..id'], kept)).toBe(1);
  });
});

describe('kpai checkpoints / restore (R-305)', () => {
  it('lists checkpoints, restore asks every time and prints the undo', async () => {
    const io = setup();
    const args = ['do', '--allow-test', '--yes', '--apply', '--yes-apply', REQ];
    expect(await main(args, io)).toBe(0);
    expect(await main(['checkpoints'], io)).toBe(0);
    const refs = [...io.stdout.matchAll(/(refs\/kpai\/checkpoints\/\S+)\s.*before patch from/g)];
    expect(refs.map((m) => m[1]?.endsWith('/1') || m[1]?.endsWith('/2'))).toEqual([true, true]);
    const first = refs[0]?.[1] as string;
    const session = /session ([0-9a-f]{8})/.exec(io.stderr)?.[1] as string;
    io.stdout = '';
    expect(await main(['checkpoints', '--session', session], io)).toBe(0);
    expect(io.stdout).toContain(first);

    expect(await main(['restore', first], io)).toBe(1);
    expect(io.stderr).toMatch(/not restored — declined by the user/);
    expect(io.questions.at(-1)).toMatch(/checkpoint\.restore \(destructive\)/);
    io.confirmAnswers = [true];
    expect(await main(['restore', first], io)).toBe(0);
    expect(io.stdout).toMatch(/restored .*: 0 written, 2 deleted\nundo: kpai restore refs/);
    expect(existsSync(join(io.cwd, 'src/s.ts'))).toBe(false);
    expect(readFileSync(join(io.cwd, 'README.md'), 'utf8')).toBe('# t\n');

    expect(await main(['restore'], io)).toBe(2);
    expect(await main(['restore', 'refs/heads/main'], io)).toBe(2);
    const empty = setup();
    expect(await main(['checkpoints'], empty)).toBe(0);
    expect(empty.stdout).toBe('no checkpoint\n');
  });
});

describe('kpai do: artifacts (D-019, ADR-0022)', () => {
  it('shows artifacts; --yes-apply writes reviewed ones, unreviewed documents are asked one by one', async () => {
    const io = setup();
    const req = [
      'write a short report about the release',
      '```artifact path="docs/report.md" kind="report"',
      '# Findings',
      '```',
      '```artifact path="../x.md" kind="report"',
      'no',
      '```',
    ].join('\n');
    expect(await main(['do', '--allow-test', '--yes', req], io)).toBe(0);
    expect(io.stderr).toMatch(
      /--- artifact docs\/report\.md \(report, text\/markdown, 10 bytes\) from draft/,
    );
    expect(io.stderr).toMatch(/--- artifact gather\.md \(report, .*NOT REVIEWED/);
    expect(io.stderr).toMatch(/✗ artifact \.\.\/x\.md from \w+ refused: path must be relative/);
    expect(io.stderr).toMatch(/artifact\(s\) shown, not written/);
    io.confirmAnswers = [true, false];
    const before = io.questions.length;
    expect(await main(['do', '--allow-test', '--yes', '--apply', '--yes-apply', req], io)).toBe(0);
    const asked = io.questions.slice(before);
    expect(asked).toHaveLength(2);
    expect(asked.every((q) => /NOT REVIEWED/.test(q))).toBe(true);
    expect(readFileSync(join(io.cwd, 'docs/report.md'), 'utf8')).toBe('# Findings');
    expect(existsSync(join(io.cwd, 'gather.md'))).toBe(true);
    expect(existsSync(join(io.cwd, 'verify.md'))).toBe(false);
    expect(io.stderr).toMatch(/✗ verify\.md: not saved: declined by the user \(not reviewed\)/);
  });
});
