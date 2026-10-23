import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GradedPermissionPolicy } from '../policy.js';
import { makeCtx, tempDir } from '../test-helpers/ctx.js';
import { git, makeRepo, put, treeOf, userState } from '../test-helpers/repo.js';
import { listCheckpoints, checkpoint } from './checkpoint.js';
import {
  createRunWorktree,
  diffRunWorktree,
  locateRunWorktree,
  mergeBack,
  removeRunWorktree,
} from './worktree.js';

const gate = (root: string, answers: boolean[] = [true]) => ({
  policy: new GradedPermissionPolicy(),
  ctx: makeCtx(root, { answers }),
});

describe('isolated worktrees per run (R-307)', () => {
  let root: string;
  let home: string;
  let cleanup: () => Promise<void>;
  let rmHome: () => Promise<void>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeRepo({
      'src/app.ts': 'export const v = 1;\n',
      'crlf.txt': 'one\r\ntwo\r\n',
      '.gitignore': 'node_modules/\n',
    }));
    ({ dir: home, cleanup: rmHome } = await tempDir('kpai-home-'));
    await put(root, {
      'src/app.ts': 'export const v = 2; // uncommitted\n',
      'notes.md': 'untracked\n',
      'node_modules/x/index.js': 'ignored\n',
      '.env': 'TOKEN=user\n',
    });
  });
  afterEach(async () => {
    await cleanup();
    await rmHome();
  });

  it('two runs at once: each starts from HEAD + uncommitted changes, diffs isolated', async () => {
    const before = userState(root);
    const a = await createRunWorktree(root, 'run-a', { home });
    const b = await createRunWorktree(root, 'run-b', { home });
    expect(a.path.startsWith(await realpath(home))).toBe(true);
    expect(path.basename(a.root)).toBe('run-a');
    expect(await readFile(path.join(a.root, 'src', 'app.ts'), 'utf8')).toContain('uncommitted');
    expect(await readFile(path.join(a.root, 'crlf.txt'), 'latin1')).toBe('one\r\ntwo\r\n');
    expect(existsSync(path.join(a.root, 'notes.md'))).toBe(true);
    expect(existsSync(path.join(a.root, 'node_modules'))).toBe(false);

    await put(a.root, { 'src/app.ts': 'export const v = 3;\n', 'src/a-only.ts': 'a\n' });
    await put(b.root, { 'notes.md': 'edited by b\n' });
    const da = await diffRunWorktree(root, 'run-a', { home });
    const db = await diffRunWorktree(root, 'run-b', { home });
    expect(da.files.sort()).toEqual(['src/a-only.ts', 'src/app.ts']);
    expect(db.files).toEqual(['notes.md']);
    expect(da.diff).toContain('+export const v = 3;');
    expect(db.diff).not.toContain('app.ts');
    // The user's tree, index, HEAD and branches are untouched by both runs.
    expect(await readFile(path.join(root, 'src', 'app.ts'), 'utf8')).toContain('uncommitted');
    expect(userState(root)).toBe(before);
  });

  it('keeps forbidden zones out of the run diff', async () => {
    const run = await createRunWorktree(root, 'z1', { home });
    await put(run.root, {
      '.env': 'TOKEN=changed-by-run\n',
      'config/secrets.yml': 'k: v\n',
      'ok.txt': 'ok\n',
    });
    const d = await diffRunWorktree(root, 'z1', { home });
    expect(d.files).toEqual(['ok.txt']);
    expect(d.diff).not.toMatch(/TOKEN|secrets/);
  });

  it('merges back only when confirmed, through git.apply, without committing', async () => {
    const run = await createRunWorktree(root, 'm1', { home });
    await put(run.root, { 'src/app.ts': 'export const v = 4;\n', 'src/added.ts': 'new\n' });
    const head = git(root, 'rev-parse', 'HEAD');
    const index = git(root, 'ls-files', '-s');

    const declined = gate(root, [false]);
    await expect(mergeBack(root, 'm1', declined, { home })).rejects.toThrow(/declined/);
    expect(await readFile(path.join(root, 'src', 'app.ts'), 'utf8')).toContain('uncommitted');
    expect(declined.ctx.questions[0]).toMatch(/worktree\.merge \(write\)[\s\S]*src\/added\.ts/);

    const res = await mergeBack(root, 'm1', gate(root), { home });
    expect(res).toMatchObject({ applied: true, files: ['src/added.ts', 'src/app.ts'] });
    expect(await readFile(path.join(root, 'src', 'app.ts'), 'utf8')).toBe('export const v = 4;\n');
    expect(await readFile(path.join(root, 'src', 'added.ts'), 'utf8')).toBe('new\n');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'ls-files', '-s')).toBe(index);
  });

  it('refuses a merge that conflicts with the user tree, and an empty merge is a no-op', async () => {
    const run = await createRunWorktree(root, 'm2', { home });
    expect(await mergeBack(root, 'm2', gate(root), { home })).toEqual({
      applied: false,
      files: [],
      omitted: 0,
    });
    await put(run.root, { 'src/app.ts': 'export const v = 5;\n' });
    await put(root, { 'src/app.ts': 'user moved on\n' });
    await expect(mergeBack(root, 'm2', gate(root), { home })).rejects.toThrow(/--check/);
  });

  it('merges with core.autocrlf=true: CRLF working files keep their line endings', async () => {
    git(root, 'config', 'core.autocrlf', 'true');
    await put(root, { 'win.txt': 'alpha\r\nbeta\r\n' });
    const run = await createRunWorktree(root, 'c1', { home });
    expect(await readFile(path.join(run.root, 'win.txt'), 'latin1')).toBe('alpha\r\nbeta\r\n');
    await put(run.root, { 'win.txt': 'alpha\r\nBETA\r\n' });
    await mergeBack(root, 'c1', gate(root), { home });
    expect(await readFile(path.join(root, 'win.txt'), 'latin1')).toBe('alpha\r\nBETA\r\n');
  });

  it('removes the worktree and its run refs; the id can then be reused', async () => {
    const run = await createRunWorktree(root, 'rm1', { home });
    await expect(createRunWorktree(root, 'rm1', { home })).rejects.toThrow(/already exists/);
    await checkpoint(run.root, 'inside the run', { run: 'rm1' });
    expect(await removeRunWorktree(root, 'rm1', { home })).toEqual({ removed: true });
    expect(existsSync(run.path)).toBe(false);
    expect(git(root, 'worktree', 'list')).not.toContain('rm1');
    expect(git(root, 'for-each-ref', 'refs/kpai/runs/')).toBe('');
    expect(await listCheckpoints(root, 'rm1')).toHaveLength(1); // checkpoints are kept
    expect(await removeRunWorktree(root, 'rm1', { home })).toEqual({ removed: false });
    await expect(diffRunWorktree(root, 'rm1', { home })).rejects.toThrow(/no worktree/);
    const again = await createRunWorktree(root, 'rm1', { home });
    expect(again.path).toBe(run.path);
  });

  it('refuses a run id already used by refs and cleans up', async () => {
    git(root, 'update-ref', 'refs/kpai/runs/dup/checkpoint', 'HEAD');
    await expect(createRunWorktree(root, 'dup', { home })).rejects.toThrow(/already used/);
    await expect(createRunWorktree(root, '../escape', { home })).rejects.toThrow(/invalid run id/);
  });

  it('uses the same subdirectory as the jail root, and runs no hooks', async () => {
    const marker = path.join(root, 'PWNED');
    const hooks = path.join(root, '.hooks');
    await mkdir(hooks);
    for (const h of ['post-checkout', 'reference-transaction']) {
      await writeFile(path.join(hooks, h), `#!/bin/sh\ntouch "${marker.replace(/\\/g, '/')}"\n`, {
        mode: 0o755,
      });
    }
    git(root, 'config', 'core.hooksPath', hooks);
    const sub = path.join(root, 'src');
    const run = await createRunWorktree(sub, 's1', { home });
    expect(run.root).toBe(path.join(run.path, 'src'));
    expect((await locateRunWorktree(sub, 's1', { home })).root).toBe(run.root);
    await put(run.root, { 'app.ts': 'export const v = 9;\n' });
    expect((await diffRunWorktree(sub, 's1', { home })).files).toEqual(['app.ts']);
    await mergeBack(sub, 's1', gate(sub), { home });
    expect(await readFile(path.join(sub, 'app.ts'), 'utf8')).toBe('export const v = 9;\n');
    expect(existsSync(marker)).toBe(false);
    // Outside the workspace subdirectory the worktree is HEAD: untracked notes.md stays out.
    expect(Object.keys(await treeOf(run.path))).not.toContain('notes.md');
  });
});
