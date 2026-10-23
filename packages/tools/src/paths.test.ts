import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkLexical,
  globToRegExp,
  isInside,
  JailError,
  matchesForbidden,
  resolveInRoot,
  touchesGitDir,
} from './paths.js';
import { tempDir } from './test-helpers/ctx.js';

const isWin = process.platform === 'win32';

describe('workspace jail', () => {
  let base: string;
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: base, cleanup } = await tempDir());
    root = path.join(base, 'ws');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.txt'), 'hello');
    await writeFile(path.join(base, 'secret.txt'), 'outside');
  });
  afterEach(() => cleanup());

  it('resolves relative paths inside the root', async () => {
    const j = await resolveInRoot(root, 'src/a.txt', { mustExist: true });
    expect(j.rel).toBe('src/a.txt');
    expect(j.exists).toBe(true);
    expect((await resolveInRoot(root, '')).rel).toBe('.');
    expect((await resolveInRoot(root, 'new/dir/file.txt')).exists).toBe(false);
  });

  it.each(['../secret.txt', 'src/../../secret.txt', 'src/..', '..\\secret.txt'])(
    'refuses .. escapes: %s',
    async (p) => {
      await expect(resolveInRoot(root, p)).rejects.toBeInstanceOf(JailError);
    },
  );

  it('refuses absolute paths outside the root but accepts them inside', async () => {
    await expect(resolveInRoot(root, path.join(base, 'secret.txt'))).rejects.toThrow(/outside/);
    const inside = await resolveInRoot(root, path.join(root, 'src', 'a.txt'));
    expect(inside.rel).toBe('src/a.txt');
  });

  // Simulates macOS /var → /private/var and Windows 8.3 names (RUNNER~1): the same
  // folder reached through an alias. A directory link (junction on Windows) stands in.
  describe('root aliases', () => {
    let alias: string;
    beforeEach(async () => {
      alias = path.join(base, 'alias-of-ws');
      await symlink(root, alias, isWin ? 'junction' : 'dir');
    });

    it('accepts absolute paths written through an alias of the root', async () => {
      const j = await resolveInRoot(root, path.join(alias, 'src', 'a.txt'), { mustExist: true });
      expect(j.rel).toBe('src/a.txt');
      const fresh = await resolveInRoot(root, path.join(alias, 'new', 'b.txt'));
      expect(fresh).toMatchObject({ rel: 'new/b.txt', exists: false });
    });

    it('accepts canonical absolute paths when the root itself is given through an alias', async () => {
      const j = await resolveInRoot(alias, path.join(root, 'src', 'a.txt'));
      expect(j.rel).toBe('src/a.txt');
      expect((await resolveInRoot(alias, 'src/a.txt')).rel).toBe('src/a.txt');
    });

    it('still refuses escapes reached through an alias', async () => {
      const outsideAlias = path.join(base, 'alias-of-base');
      await symlink(base, outsideAlias, isWin ? 'junction' : 'dir');
      await expect(resolveInRoot(root, path.join(outsideAlias, 'secret.txt'))).rejects.toThrow(
        /outside/,
      );
      await expect(resolveInRoot(alias, path.join(base, 'secret.txt'))).rejects.toThrow(/outside/);
      await expect(
        resolveInRoot(root, `${alias}${path.sep}..${path.sep}secret.txt`),
      ).rejects.toThrow(/\.\./);
    });

    it.skipIf(isWin)('still refuses a final symlink reached through an alias', async () => {
      await symlink(path.join(root, 'src', 'a.txt'), path.join(root, 'link.txt'));
      await expect(
        resolveInRoot(root, path.join(alias, 'link.txt'), { noFinalSymlink: true }),
      ).rejects.toThrow(/symlink/);
    });
  });

  it('refuses Windows drive, UNC and device paths on every OS', async () => {
    for (const p of ['\\\\server\\share\\x', '//server/share', '\\\\?\\C:\\x', 'C:foo']) {
      await expect(resolveInRoot(root, p)).rejects.toBeInstanceOf(JailError);
    }
    expect(() => checkLexical('C:\\x', 'linux')).toThrow(/drive/);
    expect(() => checkLexical('C:\\x', 'win32')).not.toThrow();
    expect(() => checkLexical('src\\a', 'linux')).toThrow(/backslash/);
    expect(checkLexical('src\\a', 'win32')).toBe('src\\a');
  });

  it('refuses NUL bytes, non-strings, missing files and a missing root', async () => {
    await expect(resolveInRoot(root, 'a\0b')).rejects.toThrow(/NUL/);
    await expect(resolveInRoot(root, 42)).rejects.toThrow(/string/);
    await expect(resolveInRoot(root, 'nope.txt', { mustExist: true })).rejects.toThrow(/not found/);
    await expect(resolveInRoot(path.join(base, 'missing'), 'x')).rejects.toThrow(/root/);
  });

  it('refuses a directory link that escapes the root (junction on Windows)', async () => {
    await mkdir(path.join(base, 'elsewhere'));
    await writeFile(path.join(base, 'elsewhere', 'x.txt'), 'x');
    await symlink(
      path.join(base, 'elsewhere'),
      path.join(root, 'link'),
      isWin ? 'junction' : 'dir',
    );
    await expect(resolveInRoot(root, 'link/x.txt')).rejects.toThrow(/escapes/);
    await expect(resolveInRoot(root, 'link/new.txt')).rejects.toThrow(/escapes/);
  });

  // File symlinks need admin rights or developer mode on Windows.
  it.skipIf(isWin)(
    'follows in-root symlinks for reads, refuses them as final write targets',
    async () => {
      await symlink(path.join(root, 'src', 'a.txt'), path.join(root, 'alias.txt'));
      expect((await resolveInRoot(root, 'alias.txt')).rel).toBe('src/a.txt');
      await expect(resolveInRoot(root, 'alias.txt', { noFinalSymlink: true })).rejects.toThrow(
        /symlink/,
      );
      await symlink(path.join(base, 'secret.txt'), path.join(root, 'leak.txt'));
      await expect(resolveInRoot(root, 'leak.txt')).rejects.toThrow(/escapes/);
    },
  );

  it('isInside handles siblings with a common prefix', () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.join(root, 'a'))).toBe(true);
    expect(isInside(root, `${root}-other`)).toBe(false);
  });
});

describe('globs', () => {
  it('compiles ** / * / ?', () => {
    expect(globToRegExp('**/*.pem').test('a/b/c.pem')).toBe(true);
    expect(globToRegExp('**/*.pem').test('c.pem')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('?.txt').test('a.txt')).toBe(true);
    expect(globToRegExp('secrets/**').test('secrets/x/y')).toBe(true);
    expect(globToRegExp('A.TXT', true).test('a.txt')).toBe(true);
  });

  it('matches forbidden zones by segment or by prefix', () => {
    const globs = ['.env*', 'secrets/', 'config/*.key'];
    expect(matchesForbidden('.env', globs, false)).toBe(true);
    expect(matchesForbidden('app/.env.local', globs, false)).toBe(true);
    expect(matchesForbidden('secrets/db/pass.txt', globs, false)).toBe(true);
    expect(matchesForbidden('config/tls.key', globs, false)).toBe(true);
    expect(matchesForbidden('src/env.ts', globs, false)).toBe(false);
    expect(matchesForbidden('src/x', [], false)).toBe(false);
    expect(matchesForbidden('SECRETS/x', ['secrets/'], true)).toBe(true);
  });

  it('detects .git segments', () => {
    expect(touchesGitDir('.git/hooks/pre-commit')).toBe(true);
    expect(touchesGitDir('sub/.GIT/config')).toBe(true);
    expect(touchesGitDir('.gitignore')).toBe(false);
  });
});
