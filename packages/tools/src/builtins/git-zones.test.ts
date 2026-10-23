import { execFileSync } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalToolBus } from '../bus.js';
import { createToolBus } from '../create.js';
import { call, makeCtx, tempDir } from '../test-helpers/ctx.js';
import { excludePathspecs, filterDiff, filterStatus } from './git-filter.js';
import { gitTools } from './git.js';

function git(cwd: string, ...args: string[]): string {
  const opts = ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'core.autocrlf=false'];
  return execFileSync('git', [...opts, ...args], { cwd, encoding: 'utf8' });
}

describe('forbidden zones stay out of git output (N2)', () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: root, cleanup } = await tempDir());
    git(root, 'init', '-q');
    await mkdir(path.join(root, 'config'));
    await writeFile(path.join(root, '.env'), 'X=1\n');
    await writeFile(path.join(root, 'config', 'secrets.yml'), 'db_password: old\n');
    await writeFile(path.join(root, 'config', 'app.yml'), 'port: 1\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');
    await writeFile(path.join(root, '.env'), 'X=supersecret\n');
    await writeFile(path.join(root, 'config', 'secrets.yml'), 'db_password: hunter2-prod\n');
    await writeFile(path.join(root, 'config', 'app.yml'), 'port: 2\n');
  });
  afterEach(() => cleanup());

  it('git.diff and git.status hide .env and config/secrets.yml (gd.mjs)', async () => {
    const bus = new LocalToolBus({ tools: gitTools() });
    for (const input of [{}, { path: 'config' }, { path: '.' }]) {
      const r = await bus.call(call('git.diff', input), makeCtx(root));
      expect(r.isError, r.content).toBe(false);
      expect(r.content).toContain('+port: 2');
      expect(r.content).not.toMatch(/supersecret|hunter2|secrets\.yml|\.env/);
    }
    git(root, 'add', '.');
    const staged = await bus.call(call('git.diff', { staged: true }), makeCtx(root));
    expect(staged.content).not.toMatch(/hunter2|supersecret/);
    const status = await bus.call(call('git.status', {}), makeCtx(root));
    expect(status.content).toContain('config/app.yml');
    expect(status.content).not.toMatch(/secrets\.yml|\.env/);
  });

  it('uses the active policy (policy.json) and can be turned off explicitly', async () => {
    const { dir: home, cleanup: rmHome } = await tempDir();
    try {
      await writeFile(
        path.join(home, 'policy.json'),
        JSON.stringify({ forbiddenPaths: ['config/app.yml'] }),
      );
      const { bus } = await createToolBus({ kpaiHome: home });
      const r = await bus.call(call('git.diff', {}), makeCtx(root));
      expect(r.content).toBe('(no output)');
    } finally {
      await rmHome();
    }
    const open = new LocalToolBus({ tools: gitTools({ forbiddenPaths: [] }) });
    const r = await open.call(call('git.diff', {}), makeCtx(root));
    expect(r.content).toContain('hunter2-prod');
  });

  it('defence in depth: drops forbidden sections and status lines from raw output', () => {
    const zones = { globs: ['.env', '**/*secret*'], caseInsensitive: false };
    const diff = [
      'diff --git a/.env b/.env',
      '+X=supersecret',
      'diff --git a/src/a.ts b/src/a.ts',
      '+ok',
      'diff --git a/x b/config/secrets.yml',
      '+hunter2',
      '',
    ].join('\n');
    const out = filterDiff(diff, zones);
    expect(out).toBe(
      'diff --git a/src/a.ts b/src/a.ts\n+ok\n[2 entries in forbidden zones omitted]\n',
    );
    const status = '## main\n M .env\n M src/a.ts\nR  old.txt -> my-secret.txt\n';
    expect(filterStatus(status, zones)).toBe(
      '## main\n M src/a.ts\n[2 entries in forbidden zones omitted]\n',
    );
    expect(filterDiff(diff, { globs: [], caseInsensitive: false })).toBe(diff);
    expect(filterStatus(status, { globs: [], caseInsensitive: false })).toBe(status);
  });

  it('turns globs into git exclude pathspecs', () => {
    expect(
      excludePathspecs({
        globs: ['.env', 'secrets/', 'private/**', 'a/b.txt', ''],
        caseInsensitive: true,
      }),
    ).toEqual([
      ':(exclude,glob,icase)**/.env',
      ':(exclude,glob,icase)**/.env/**',
      ':(exclude,glob,icase)**/secrets',
      ':(exclude,glob,icase)**/secrets/**',
      ':(exclude,glob,icase)private/**',
      ':(exclude,glob,icase)private',
      ':(exclude,glob,icase)a/b.txt',
    ]);
  });
});

describe('submodules never run their filters (N4)', () => {
  let base: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: base, cleanup } = await tempDir());
    const sub = path.join(base, 'sub');
    const sup = path.join(base, 'sup');
    await mkdir(sub);
    await mkdir(sup);
    git(sub, 'init', '-q');
    await writeFile(path.join(sub, 'g.txt'), 'g\n');
    await writeFile(path.join(sub, '.gitattributes'), '* filter=y\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-qm', 'sub');
    git(sup, 'init', '-q');
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sm');
    git(sup, 'commit', '-qm', 'sup');
    // r3/sup: the submodule's own config defines the filter; it leaves ../PWNED2.
    const sm = path.join(sup, 'sm');
    git(sm, 'config', 'filter.y.clean', `node -e "require('fs').writeFileSync('../PWNED2','')"`);
    await new Promise((r) => setTimeout(r, 1100));
    await writeFile(path.join(sm, 'g.txt'), 'changed\n');
  });
  afterEach(() => cleanup());

  it('git.status and git.diff in the superproject do not descend (status.mjs)', async () => {
    const sup = path.join(base, 'sup');
    const bus = new LocalToolBus({ tools: gitTools() });
    const status = await bus.call(call('git.status', {}), makeCtx(sup));
    expect(status.isError, status.content).toBe(false);
    const diff = await bus.call(call('git.diff', {}), makeCtx(sup));
    expect(diff.isError, diff.content).toBe(false);
    await expect(stat(path.join(sup, 'PWNED2'))).rejects.toThrow();
  });
});
