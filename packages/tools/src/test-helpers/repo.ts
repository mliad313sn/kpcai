import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from './ctx.js';

/** Git for test fixtures: fixed identity, no eol conversion, no hooks from the user's config. */
export function git(cwd: string, ...args: string[]): string {
  const opts = ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'core.autocrlf=false'];
  return execFileSync('git', [...opts, ...args], { cwd, encoding: 'utf8' });
}

/** Writes files (creating parents) relative to root. */
export async function put(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

/** A temp repository with one commit of `files`. */
export async function makeRepo(
  files: Record<string, string | Buffer> = { 'README.md': 'hello\n' },
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const { dir, cleanup } = await tempDir('kpai-ws-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  await put(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return { root: dir, cleanup };
}

/**
 * Every file under root (skipping .git) as `path → content` (links as `-> target`),
 * for comparing whole trees.
 */
export async function treeOf(
  root: string,
  skip: readonly string[] = [],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const r = rel === '' ? name : `${rel}/${name}`;
      if (name === '.git' || skip.includes(r)) continue;
      const abs = path.join(dir, name);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) out[r] = `-> ${await readlink(abs)}`;
      else if (st.isDirectory()) await walk(abs, r);
      else out[r] = (await readFile(abs)).toString('latin1');
    }
  };
  await walk(root, '');
  return out;
}

/** Refs, stash and index state that WP8 must never change. */
export function userState(root: string): string {
  const refs = git(
    root,
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/heads',
    'refs/stash',
  );
  const head = git(root, 'symbolic-ref', '-q', 'HEAD').trim();
  const index = git(root, 'ls-files', '-s');
  return `${head}\n${refs}\n${index}`;
}
