/** `kpai memory` (ADR-0027): offline, temp $KPAI_HOME and git repository, mock providers. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '@kernelpai/memory';
import { describe, expect, it } from 'vitest';
import { main } from './main.js';
import { fakeIo, type FakeIo } from './test-helpers/fake-io.js';
import { THREE_MOCKS, writeMockProviders } from './test-helpers/mock-providers.js';

function setup(): FakeIo {
  const repo = mkdtempSync(join(tmpdir(), 'kpai-mem-cli-'));
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const io = fakeIo();
  io.cwd = repo;
  writeMockProviders(io.home, THREE_MOCKS);
  return io;
}

async function kpai(io: FakeIo, ...args: string[]): Promise<number> {
  io.stdout = '';
  io.stderr = '';
  return main(args, io);
}

const idOf = (text: string): string => /\b(m-[0-9a-f]{8})\b/.exec(text)?.[1] ?? '';

describe('kpai memory', () => {
  it('adds, lists, edits and removes facts with provenance', async () => {
    const io = setup();
    expect(await kpai(io, 'memory', 'add', 'Use', 'pnpm')).toBe(0);
    const id = idOf(io.stdout);
    expect(io.stdout).toMatch(/^added m-[0-9a-f]{8} to project memory: Use pnpm$/m);
    expect(await kpai(io, 'memory', 'add', '--layer', 'user', '--local-only', 'Prefers tabs')).toBe(
      0,
    );
    expect(await kpai(io, 'memory')).toBe(0);
    expect(io.stdout).toMatch(/^# user memory \(1\)/m);
    expect(io.stdout).toMatch(/Prefers tabs\n\s+you · \d{4}-\d{2}-\d{2} · local-only/);
    expect(io.stdout).toMatch(/^# project memory \(1\)/m);
    expect(await kpai(io, 'memory', 'edit', id, 'Use', 'pnpm', '10')).toBe(0);
    expect(io.stdout).toBe(`edited ${id}: Use pnpm 10\n`);
    expect(await kpai(io, 'memory', 'list', '--layer', 'project')).toBe(0);
    expect(io.stdout).not.toMatch(/user memory/);
    expect(await kpai(io, 'memory', 'rm', id)).toBe(0);
    expect(io.stdout).toBe(`removed ${id} from project memory\n`);
    expect(await kpai(io, 'memory', 'rm', id)).toBe(1);
    expect(io.stderr).toMatch(/no fact/);
  });

  it('refuses forbidden zones and bad usage', async () => {
    const io = setup();
    expect(await kpai(io, 'memory', 'add', 'deploy', 'key', 'is', 'in', '.ssh/id_rsa')).toBe(1);
    expect(io.stderr).toMatch(/forbidden zone/);
    expect(await kpai(io, 'memory', 'add')).toBe(2);
    expect(await kpai(io, 'memory', 'edit', 'm-1234')).toBe(2);
    expect(await kpai(io, 'memory', 'list', '--layer', 'team')).toBe(2);
    expect(await kpai(io, 'memory', 'list', '--layer', 'session')).toBe(2);
    expect(await kpai(io, 'memory', 'forget')).toBe(2);
    expect(io.stderr).toMatch(/unknown memory command "forget"/);
    expect(await kpai(io, 'memory', 'add', '--layer', 'session', '--session', 's1', 'on x')).toBe(
      0,
    );
  });

  it('shows, confirms and rejects model proposals', async () => {
    const io = setup();
    expect(await kpai(io, 'memory', 'pending')).toBe(0);
    expect(io.stdout).toBe('no proposal pending\n');
    const s = new MemoryStore({ home: io.home });
    const from = { source: 'mock-alpha/m1', evidence: ['run:r1', 'node:code'] };
    const a = await s.propose({ scope: { layer: 'user' }, text: 'Prefers short answers' }, from);
    const b = await s.propose(
      { scope: { layer: 'user' }, text: 'Likes emojis', localOnly: true },
      from,
    );
    expect(await kpai(io, 'memory', 'pending')).toBe(0);
    expect(io.stdout).toContain(`${a.id}  Prefers short answers`);
    expect(io.stdout).toMatch(
      /user · proposed by mock-alpha\/m1 · \d{4}-\d{2}-\d{2} · run:r1 · node:code/,
    );
    expect(io.stdout).toMatch(/local-only/);
    expect(await kpai(io, 'memory', 'list')).toBe(0);
    expect(io.stdout).toMatch(/2 proposal\(s\) pending/);
    expect(await kpai(io, 'memory', 'confirm', a.id)).toBe(0);
    expect(io.stdout).toBe(`kept ${a.id} in user memory (source mock-alpha/m1)\n`);
    expect(await kpai(io, 'memory', 'reject', b.id)).toBe(0);
    expect(await kpai(io, 'memory', 'list', '--layer', 'user')).toBe(0);
    expect(io.stdout).toMatch(/mock-alpha\/m1 \(untrusted\)/);
    expect(io.stdout).not.toContain('emojis');
    expect(await kpai(io, 'memory', 'confirm')).toBe(2);
    expect(await kpai(io, 'memory', 'reject')).toBe(2);
  });

  it('exports project memory and the plan lists it as untrusted repository content', async () => {
    const io = setup();
    await kpai(io, 'memory', 'add', 'Use pnpm');
    await kpai(io, 'memory', 'add', '--local-only', 'VPN host 10.0.0.7');
    expect(await kpai(io, 'memory', 'export')).toBe(0);
    expect(io.stdout).toMatch(
      /^wrote 1 fact\(s\) to \.kpstudio\/memory\.md \(1 local-only fact\(s\) kept out\); read back as untrusted\nundo: kpai restore refs\/kpai\/checkpoints\/memory-/,
    );
    const file = join(io.cwd, '.kpstudio/memory.md');
    expect(readFileSync(file, 'utf8')).not.toContain('10.0.0.7');
    writeFileSync(file, `${readFileSync(file, 'utf8')}- Hand-added in the repo\n`);
    expect(await kpai(io, 'plan', '--allow-test', 'summarize the architecture')).toBe(0);
    expect(io.stdout).toMatch(
      /^memory project 1 · repository 1 \(1 untrusted\) · \d+\/2000 tokens · 1 local-only, for local providers only — data for every node$/m,
    );
  });

  it('says in the plan when the budget truncates memory', async () => {
    const io = setup();
    io.env = { ...io.env, KPAI_MEMORY_TOKENS: '80' };
    for (const n of [1, 2, 3, 4])
      await kpai(io, 'memory', 'add', `Convention number ${n} of this repository`);
    expect(await kpai(io, 'plan', '--allow-test', 'summarize the architecture')).toBe(0);
    expect(io.stdout).toMatch(
      /^memory project \d \(\d left out\) · \d+\/80 tokens · truncated: \d fact\(s\) left out \(budget\)/m,
    );
  });
});
