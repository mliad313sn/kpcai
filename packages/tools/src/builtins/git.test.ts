import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalToolBus } from '../bus.js';
import { GradedPermissionPolicy } from '../policy.js';
import { call, makeCtx, tempDir } from '../test-helpers/ctx.js';
import { gitTools, patchTargets } from './git.js';

function git(cwd: string, ...args: string[]): string {
  const opts = ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'core.autocrlf=false'];
  return execFileSync('git', [...opts, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

/** File text with CRLF folded to LF, so assertions hold whatever the runner's git config. */
async function text(file: string): Promise<string> {
  return (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
}

const PATCH = [
  'diff --git a/src/a.txt b/src/a.txt',
  '--- a/src/a.txt',
  '+++ b/src/a.txt',
  '@@ -1 +1 @@',
  '-one',
  '+two',
  '',
].join('\n');

describe('git built-ins', () => {
  let base: string;
  let root: string;
  let cleanup: () => Promise<void>;
  let bus: LocalToolBus;
  let policy: GradedPermissionPolicy;

  beforeEach(async () => {
    ({ dir: base, cleanup } = await tempDir());
    root = path.join(base, 'repo');
    await mkdir(path.join(root, 'src'), { recursive: true });
    git(root, 'init', '-q');
    git(root, 'config', 'core.autocrlf', 'false');
    await writeFile(path.join(root, 'src', 'a.txt'), 'one\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'first commit');
    policy = new GradedPermissionPolicy();
    policy.trust({ sessionId: 's1', root, risk: 'write' });
    bus = new LocalToolBus({ tools: gitTools(), policy });
  });
  afterEach(() => cleanup());

  it('status, diff (unstaged and staged, with pathspec) and log', async () => {
    const ctx = makeCtx(root);
    expect((await bus.call(call('git.status', {}), ctx)).content).toMatch(/^## /);
    await writeFile(path.join(root, 'src', 'a.txt'), 'changed\n');
    const status = await bus.call(call('git.status', {}), ctx);
    expect(status.content).toContain(' M src/a.txt');
    const diff = await bus.call(call('git.diff', { path: 'src' }), ctx);
    expect(diff.content).toContain('+changed');
    const staged = await bus.call(call('git.diff', { staged: true }), ctx);
    expect(staged.content).toBe('(no output)');
    const log = await bus.call(call('git.log', { maxCount: 5 }), ctx);
    expect(log.content).toMatch(/first commit/);
    const escape = await bus.call(call('git.diff', { path: '../' }), ctx);
    expect(escape.isError).toBe(true);
    expect(ctx.questions).toHaveLength(0);
  });

  it('disables pathspec magic and keeps reads to a subdirectory root', async () => {
    await writeFile(path.join(root, 'top.txt'), 'outside the sub root\n');
    await writeFile(path.join(root, 'src', 'a.txt'), 'changed\n');
    const magic = await bus.call(call('git.diff', { path: ':(top)' }), makeCtx(root));
    expect(magic.content).not.toContain('+changed');
    const sub = makeCtx(path.join(root, 'src'));
    const status = await bus.call(call('git.status', {}), sub);
    expect(status.content).toContain('src/a.txt');
    expect(status.content).not.toContain('top.txt');
  });

  it('reports git failures as isError', async () => {
    const notRepo = path.join(base, 'plain');
    await mkdir(notRepo);
    const r = await bus.call(call('git.log', {}), makeCtx(notRepo));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/git exited with/);
    const missing = new LocalToolBus({ tools: gitTools({ gitBinary: 'kpai-no-such-git' }) });
    const m = await missing.call(call('git.status', {}), makeCtx(root));
    expect(m.content).toMatch(/failed to start/);
  });

  it('applies a valid patch after --check', async () => {
    const r = await bus.call(call('git.apply', { patch: PATCH }), makeCtx(root));
    expect(r).toEqual({ content: 'applied patch to 1 file(s): src/a.txt', isError: false });
    expect(await text(path.join(root, 'src', 'a.txt'))).toBe('two\n');
  });

  it('applies relative to a subdirectory root', async () => {
    const sub = path.join(root, 'src');
    policy.trust({ sessionId: 's1', root: sub, risk: 'write' });
    const patch = PATCH.replace(/src\//g, '');
    const r = await bus.call(call('git.apply', { patch }), makeCtx(sub));
    expect(r.isError).toBe(false);
    expect(await text(path.join(sub, 'a.txt'))).toBe('two\n');
    // Plain patches (no `diff --git` line) land in the same place.
    const plain = PATCH.replace(/src\//g, '')
      .replace(/^diff --git.*\n/, '')
      .replace(/one|two/g, (m) => (m === 'one' ? 'two' : 'three'));
    expect((await bus.call(call('git.apply', { patch: plain }), makeCtx(sub))).isError).toBe(false);
    expect(await text(path.join(sub, 'a.txt'))).toBe('three\n');
    expect(git(root, 'status', '--porcelain')).toBe(' M src/a.txt\n');
  });

  it("honours the repository's own config (core.autocrlf) from a subdirectory root", async () => {
    git(root, 'config', 'core.autocrlf', 'true');
    const sub = path.join(root, 'src');
    policy.trust({ sessionId: 's1', root: sub, risk: 'write' });
    const r = await bus.call(
      call('git.apply', { patch: PATCH.replace(/src\//g, '') }),
      makeCtx(sub),
    );
    expect(r.isError).toBe(false);
    expect(await readFile(path.join(sub, 'a.txt'), 'utf8')).toBe('two\r\n');
  });

  it('leaves the tree untouched when --check fails', async () => {
    const bad = PATCH.replace('-one', '-something else');
    const r = await bus.call(call('git.apply', { patch: bad }), makeCtx(root));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/patch does not apply|git exited/);
    expect(await text(path.join(root, 'src', 'a.txt'))).toBe('one\n');
  });

  it('refuses patches that leave the root or touch .git or symlinks', async () => {
    const cases: [string, RegExp][] = [
      ['--- a/../evil.txt\n+++ b/../evil.txt\n@@ -0,0 +1 @@\n+x\n', /\.\./],
      ['--- /dev/null\n+++ b/.git/hooks/pre-commit\n@@ -0,0 +1 @@\n+x\n', /\.git/],
      ['--- src/a.txt\n+++ src/a.txt\n', /a\/ or b\//],
      ['diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n', /symlink/],
      ['just text', /no file headers/],
    ];
    for (const [patch, re] of cases) {
      const r = await bus.call(call('git.apply', { patch }), makeCtx(root));
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(re);
    }
    expect(() => patchTargets('rename from x\nrename to y\n--- a/x\n+++ b/y\n')).not.toThrow();
  });

  it('asks before applying when the folder is not trusted', async () => {
    const strict = new LocalToolBus({ tools: gitTools() });
    const ctx = makeCtx(root, { answers: [false] });
    const r = await strict.call(call('git.apply', { patch: PATCH }), ctx);
    expect(r.content).toMatch(/declined/);
    expect(ctx.questions[0]).toMatch(/git\.apply \(write\)/);
    expect(await text(path.join(root, 'src', 'a.txt'))).toBe('one\n');
  });
});
