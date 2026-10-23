/** `kpai program …` and `kpai serve` (ADR-0035) with offline mock providers in a git repo. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnterpriseRuntime } from '@kernelpai/enterprise';
import { Kernel } from '@kernelpai/kernel';
import { fakeStarter } from '../../../packages/enterprise/src/test-helpers/fake.js';
import { main } from './main.js';
import { fakeIo, type FakeIo } from './test-helpers/fake-io.js';
import { writeMockProviders } from './test-helpers/mock-providers.js';

function setup(): FakeIo {
  const repo = mkdtempSync(join(tmpdir(), 'kpai-program-'));
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

const idOf = (out: string): string => /program (prog-[0-9a-f]+)/.exec(out)![1]!;
const hashOf = (out: string): string => /charter ([0-9a-f]{64})/.exec(out)![1]!;

describe('kpai program', () => {
  it('drafts with a critic and a baseline, approves by hash, steers and shows', async () => {
    const io = setup();
    const goal =
      'Two parts:\n- add a parser with tests [[diff:src/a.ts]]\n- add a printer [[diff:src/b.ts]]';
    expect(await main(['program', 'new', goal, '--budget', '5', '--allow-test'], io)).toBe(0);
    expect(io.stdout).toMatch(/team: Builder, Independent reviewer/);
    expect(io.stdout).toMatch(/as one run: likely \$/);
    expect(io.stdout).toMatch(/critique \(done/);
    const id = idOf(io.stdout);
    // Without the hash, the terminal asks; a no approves nothing.
    expect(await main(['program', 'approve', id], io)).toBe(1);
    expect(await main(['program', 'approve', id, hashOf(io.stdout)], io)).toBe(0);
    for (const sub of ['pause', 'resume', 'list', 'inbox'])
      expect(
        await main(['program', sub, ...(sub === 'list' || sub === 'inbox' ? [] : [id])], io),
      ).toBe(0);
    expect(io.stdout).toMatch(/nothing waits for you/);
    expect(await main(['program', 'show', id], io)).toBe(0);
    expect(io.stdout).toMatch(new RegExp(`${id}: (approved|running)`));
    expect(await main(['program', 'stop', id], io)).toBe(0);
    expect(io.stdout).toMatch(/: stopped/);
    expect(await main(['program', 'heartbeat', '--check'], io)).toBe(1);
    expect(await main(['program', 'nope'], io)).toBe(2);
    expect(await main(['program', 'show', 'prog-none'], io)).toBe(1);
  });

  it('a consequential answer shows its evidence first; trivial ones go together', async () => {
    const io = setup();
    expect(
      await main(
        ['program', 'new', 'one thing', '--budget', '1', '--no-critic', '--allow-test'],
        io,
      ),
    ).toBe(0);
    const id = idOf(io.stdout);
    expect(await main(['program', 'approve', id, hashOf(io.stdout)], io)).toBe(0);
    // The daemon's side: a run over the envelope becomes a question.
    const kernel = new Kernel({ env: io.env, cwd: io.cwd });
    const rt = new EnterpriseRuntime({ kernel, env: io.env });
    const fake = fakeStarter(rt);
    fake.figures = { capUsd: 3, providers: ['mock-beta'], source: 'api' };
    await rt.daemon.tick();
    await rt.idle();
    const esc = rt.get(id).escalations[0]!.id;
    await rt.close();
    await kernel.close();
    expect(await main(['program', 'inbox', id], io)).toBe(0);
    expect(io.stdout).toMatch(/\[consequential\] budget\./);
    expect(await main(['program', 'answer', id, '--trivial', 'yes'], io)).toBe(0);
    expect(io.stdout).toMatch(/no trivial question waits/);
    io.confirmAnswers.push(true);
    expect(await main(['program', 'answer', id, esc, 'yes'], io)).toBe(0);
    expect(io.stdout).toMatch(new RegExp(`--- ${esc} \\(budget\\.[a-z]+\\) evidence`));
    expect(io.stdout).toMatch(/one run of wp1 up to \$3\.00/);
    expect(io.stdout).toMatch(new RegExp(`${esc}: yes`));
    expect(await main(['program', 'answer', id], io)).toBe(2);
  });
});

describe('kpai serve', () => {
  it('runs the headless daemon until Ctrl+C', async () => {
    const io = setup();
    const done = main(['serve', '--headless', '--allow-test'], io);
    for (let i = 0; i < 200 && !io.stdout.includes('daemon on'); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(io.stdout).toMatch(/KernelPAI daemon on http:\/\/127\.0\.0\.1:\d+ \(headless/);
    io.interrupt();
    expect(await done).toBe(0);
    expect(io.stderr).toMatch(/daemon stopped/);
    expect(await main(['program', 'heartbeat'], io)).toBe(0);
    expect(io.stdout).toMatch(/daemon (ok|stale|alert) at/);
  });
});
