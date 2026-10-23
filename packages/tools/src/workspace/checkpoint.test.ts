import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalToolBus } from '../bus.js';
import { gitTools } from '../builtins/git.js';
import { GradedPermissionPolicy } from '../policy.js';
import { call, makeCtx, tempDir } from '../test-helpers/ctx.js';
import { git, makeRepo, put, treeOf, userState } from '../test-helpers/repo.js';
import { checkpoint, listCheckpoints, resolveCheckpoint, restore } from './checkpoint.js';

const isWin = process.platform === 'win32';
const yes = (root: string) => ({
  policy: new GradedPermissionPolicy(),
  ctx: makeCtx(root, { answers: [true] }),
});

const PATCH_1 = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-export const v = 1;',
  '+export const v = 2;',
  '',
].join('\n');
const PATCH_2 = [
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1 @@',
  '+export const n = 1;',
  '',
].join('\n');

describe('checkpoints and rollback (R-305)', () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeRepo({
      'src/app.ts': 'export const v = 1;\n',
      'crlf.txt': 'a\r\nb\r\n',
      'bin.dat': Buffer.from([0, 1, 2, 255, 13, 10]),
      'gone.txt': 'tracked, deleted before the checkpoint\n',
      '.gitignore': 'build/\n*.log\n',
    }));
    // A stash and a staged change that must survive everything.
    await put(root, { 'stashed.txt': 'x\n' });
    git(root, 'add', 'stashed.txt');
    git(root, 'stash', '-q');
    await put(root, { 'staged.txt': 'staged\n' });
    git(root, 'add', 'staged.txt');
    await put(root, { 'untracked.md': 'u\n', 'build/out.js': 'ignored\n' });
    await rm(path.join(root, 'gone.txt'));
  });
  afterEach(() => cleanup());

  it('apply 2 patches, roll back to checkpoint 1: tree equals checkpoint 1, user state untouched', async () => {
    const before = userState(root);
    const cp1 = await checkpoint(root, 'before patch 1', { run: 'r1' });
    const tree1 = await treeOf(root);
    const bus = new LocalToolBus({ tools: gitTools() });
    const ctx = makeCtx(root, { answers: [true, true] });
    expect((await bus.call(call('git.apply', { patch: PATCH_1 }), ctx)).isError).toBe(false);
    const cp2 = await checkpoint(root, 'before patch 2', { run: 'r1' });
    expect((await bus.call(call('git.apply', { patch: PATCH_2 }), ctx)).isError).toBe(false);
    await put(root, { 'crlf.txt': 'changed\n', 'build/new.log': 'ignored, created later\n' });
    expect(cp1.ref).toBe('refs/kpai/checkpoints/r1/1');
    expect(cp2.n).toBe(2);
    expect(userState(root)).toBe(before);

    const gate = yes(root);
    const res = await restore(root, cp1.ref, gate);
    expect(res.deleted).toEqual(['src/new.ts']);
    expect(res.written.sort()).toEqual(['crlf.txt', 'src/app.ts']);
    expect(await treeOf(root, ['build/new.log'])).toEqual(tree1);
    expect(await readFile(path.join(root, 'crlf.txt'), 'latin1')).toBe('a\r\nb\r\n');
    expect(existsSync(path.join(root, 'build', 'new.log'))).toBe(true); // ignored: kept
    expect(existsSync(path.join(root, 'gone.txt'))).toBe(false);
    expect(userState(root)).toBe(before);
    expect(git(root, 'stash', 'list')).toContain('stash@{0}');
    expect(gate.ctx.questions[0]).toMatch(
      /checkpoint\.restore \(destructive\)[\s\S]*delete src\/new\.ts/,
    );
    // The restore itself can be undone.
    expect(res.undo).toBe('refs/kpai/checkpoints/r1/3');
    await restore(root, res.undo, yes(root));
    expect(await readFile(path.join(root, 'src', 'new.ts'), 'utf8')).toBe('export const n = 1;\n');
    expect(userState(root)).toBe(before);
  });

  it('lists checkpoints of a run in order, with labels', async () => {
    await checkpoint(root, 'one\nwith\x1b[31m controls', { run: 'r2' });
    await checkpoint(root, '', { run: 'r2' });
    await checkpoint(root, 'other run', { run: 'r3' });
    const list = await listCheckpoints(root, 'r2');
    expect(list.map((c) => [c.n, c.label])).toEqual([
      [1, 'one with controls'],
      [2, 'checkpoint'],
    ]);
    expect(list[0]?.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await resolveCheckpoint(root, list[1]?.ref ?? '')).toBe(list[1]?.commit);
  });

  it('refuses bad run ids and refs outside the namespace', async () => {
    await expect(checkpoint(root, 'x', { run: '../x' })).rejects.toThrow(/invalid run id/);
    await expect(listCheckpoints(root, 'a.lock')).rejects.toThrow(/invalid run id/);
    await expect(restore(root, 'refs/heads/main', yes(root))).rejects.toThrow(
      /not a checkpoint ref/,
    );
    await expect(restore(root, 'refs/kpai/checkpoints/r9/1', yes(root))).rejects.toThrow(
      /not found/,
    );
  });

  it('a declined or denied restore changes nothing', async () => {
    const cp = await checkpoint(root, 'c', { run: 'r4' });
    await put(root, { 'src/app.ts': 'edited\n' });
    const declined = {
      policy: new GradedPermissionPolicy(),
      ctx: makeCtx(root, { answers: [false] }),
    };
    await expect(restore(root, cp.ref, declined)).rejects.toThrow(/declined/);
    const denied = {
      policy: new GradedPermissionPolicy({ denyByModel: { 'mock/*': ['checkpoint.*'] } }),
      ctx: makeCtx(root, { answers: [true] }),
    };
    await expect(restore(root, cp.ref, denied)).rejects.toThrow(/permission deny/);
    expect(await readFile(path.join(root, 'src', 'app.ts'), 'utf8')).toBe('edited\n');
  });

  it('never writes, deletes or names forbidden-zone files on restore', async () => {
    await put(root, { '.env': 'TOKEN=old\n' });
    const cp = await checkpoint(root, 'c', { run: 'r5' });
    await put(root, { '.env': 'TOKEN=new\n', 'config/secrets.yml': 'k: v\n', 'a.txt': 'a\n' });
    const gate = yes(root);
    const res = await restore(root, cp.ref, gate);
    expect(res.skipped).toBe(2);
    expect(res.deleted).toEqual(['a.txt']);
    expect(await readFile(path.join(root, '.env'), 'utf8')).toBe('TOKEN=new\n');
    expect(existsSync(path.join(root, 'config', 'secrets.yml'))).toBe(true);
    expect(gate.ctx.questions[0]).not.toMatch(/\.env|secrets/);
    expect(gate.ctx.questions[0]).toContain('2 in forbidden zones left untouched');
  });

  it('restores file modes and replaces a directory or a link in the way', async () => {
    if (!isWin) await chmod(path.join(root, 'src', 'app.ts'), 0o755);
    const cp = await checkpoint(root, 'c', { run: 'r6' });
    if (!isWin) await chmod(path.join(root, 'src', 'app.ts'), 0o644);
    await rm(path.join(root, 'untracked.md'));
    await mkdir(path.join(root, 'untracked.md'));
    await rm(path.join(root, 'src'), { recursive: true });
    await put(root, { src: 'now a file\n' });
    await restore(root, cp.ref, yes(root));
    expect(await readFile(path.join(root, 'untracked.md'), 'utf8')).toBe('u\n');
    expect(await readFile(path.join(root, 'src', 'app.ts'), 'utf8')).toBe('export const v = 1;\n');
    if (!isWin) expect((await stat(path.join(root, 'src', 'app.ts'))).mode & 0o111).not.toBe(0);
  });

  it('stops instead of deleting ignored files that are in the way', async () => {
    await put(root, { d: 'file at checkpoint time\n' });
    const cp = await checkpoint(root, 'c', { run: 'r10' });
    await rm(path.join(root, 'd'));
    await put(root, { 'd/keep.log': 'ignored user data\n' });
    await expect(restore(root, cp.ref, yes(root))).rejects.toThrow(/non-empty directory/);
    expect(await readFile(path.join(root, 'd', 'keep.log'), 'utf8')).toBe('ignored user data\n');
    // An ignored file where the checkpoint has a directory is never replaced either.
    await rm(path.join(root, 'd'), { recursive: true });
    await rm(path.join(root, 'src'), { recursive: true });
    await put(root, { d: 'file at checkpoint time\n', src: 'ignored file now\n' });
    await writeFile(path.join(root, '.gitignore'), 'build/\n*.log\nsrc\n');
    await expect(restore(root, cp.ref, yes(root))).rejects.toThrow(/parent is not a directory/);
  });

  it('works on an unborn branch and from a subdirectory root (only that subtree)', async () => {
    const { dir: fresh, cleanup: rmFresh } = await tempDir('kpai-ws-');
    try {
      git(fresh, 'init', '-q');
      await put(fresh, { 'pkg/a.txt': 'a\n', 'other/b.txt': 'b\n' });
      const sub = path.join(fresh, 'pkg');
      const cp = await checkpoint(sub, 'first', { run: 'r7' });
      await put(fresh, { 'pkg/a.txt': 'A\n', 'pkg/c.txt': 'c\n', 'other/b.txt': 'B\n' });
      const res = await restore(sub, cp.ref, yes(sub));
      expect(res.written).toEqual(['a.txt']);
      expect(res.deleted).toEqual(['c.txt']);
      expect(await readFile(path.join(fresh, 'other', 'b.txt'), 'utf8')).toBe('B\n');
    } finally {
      await rmFresh();
    }
  });

  it('runs no hooks or filter drivers', async () => {
    const marker = path.join(root, 'PWNED');
    const hooks = path.join(root, 'hooks');
    await mkdir(hooks);
    const script = `#!/bin/sh\ntouch "${marker.replace(/\\/g, '/')}"\n`;
    for (const h of ['reference-transaction', 'post-checkout', 'post-index-change']) {
      await writeFile(path.join(hooks, h), script, { mode: 0o755 });
    }
    git(root, 'config', 'core.hooksPath', hooks);
    git(root, 'config', 'filter.evil.clean', `touch "${marker.replace(/\\/g, '/')}"`);
    git(root, 'config', 'filter.evil.required', 'true');
    await put(root, { '.gitattributes': '*.txt filter=evil\n', 'f.txt': 'f\n' });
    const cp = await checkpoint(root, 'c', { run: 'r8' });
    await put(root, { 'f.txt': 'g\n' });
    await restore(root, cp.ref, yes(root));
    expect(existsSync(marker)).toBe(false);
    expect(await readFile(path.join(root, 'f.txt'), 'utf8')).toBe('f\n');
  });

  it.skipIf(isWin)(
    'stores links as links and never reads through a symlinked directory',
    async () => {
      const { dir: outside, cleanup: rmOut } = await tempDir();
      try {
        await writeFile(path.join(outside, 'x.txt'), 'outside secret\n');
        await put(root, { 'sub/x.txt': 'inside\n' });
        git(root, 'add', 'sub/x.txt');
        await rm(path.join(root, 'sub'), { recursive: true });
        await symlink(outside, path.join(root, 'sub')); // index still lists sub/x.txt
        await symlink('src/app.ts', path.join(root, 'alias'));
        const cp = await checkpoint(root, 'c', { run: 'r9' });
        const tree = git(root, 'ls-tree', '-r', cp.commit);
        expect(tree).toMatch(/120000 blob \w+\talias/);
        expect(tree).not.toContain('sub/x.txt');
        expect(tree).toMatch(/120000 blob \w+\tsub\n/);
      } finally {
        await rmOut();
      }
      await rm(path.join(root, 'alias'));
      await put(root, { alias: 'plain file now\n' });
      const cp = (await listCheckpoints(root, 'r9'))[0];
      await restore(root, cp?.ref ?? '', yes(root));
      expect((await treeOf(root, ['build', 'sub'])).alias).toBe('-> src/app.ts');
    },
  );
});
