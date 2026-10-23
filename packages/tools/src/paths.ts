import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

/** A path refused by the workspace jail. The message is safe to show to a model. */
export class JailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JailError';
  }
}

/** Splits on both separators so `a\..\b` is caught on every OS. */
function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

/** True when `target` is `root` or below it (both already absolute and normalised). */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Lexical checks done before touching the file system: refuses NUL bytes, `..`
 * segments, Windows drive / UNC / device paths, and (on POSIX) backslashes.
 * Absolute paths pass here and are checked against the root afterwards.
 */
export function checkLexical(p: unknown, platform: NodeJS.Platform = process.platform): string {
  if (typeof p !== 'string') throw new JailError('path must be a string');
  const raw = p.trim() === '' ? '.' : p;
  if (raw.includes('\0')) throw new JailError('path contains a NUL byte');
  if (segments(raw).includes('..')) throw new JailError(`path may not contain "..": ${raw}`);
  if (/^[\\/]{2}/.test(raw)) throw new JailError(`UNC and device paths are refused: ${raw}`);
  const drive = /^[a-zA-Z]:/.test(raw);
  if (drive && platform !== 'win32') throw new JailError(`drive paths are refused: ${raw}`);
  if (drive && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new JailError(`drive-relative paths are refused: ${raw}`);
  }
  if (platform !== 'win32' && raw.includes('\\')) {
    throw new JailError(`backslashes are refused in paths on this OS: ${raw}`);
  }
  return raw;
}

async function realOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
}

/** Resolves the deepest existing ancestor through symlinks and re-appends the rest. */
async function realResolve(abs: string): Promise<{ real: string; exists: boolean }> {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    const real = await realOrUndefined(cur);
    if (real !== undefined)
      return { real: path.join(real, ...tail.reverse()), exists: tail.length === 0 };
    const parent = path.dirname(cur);
    if (parent === cur) return { real: abs, exists: false };
    tail.push(path.basename(cur));
    cur = parent;
  }
}

export interface JailedPath {
  /** Real absolute path (symlinks resolved), inside the real root. */
  abs: string;
  /** Root-relative path with `/` separators (`.` for the root itself). */
  rel: string;
  exists: boolean;
  realRoot: string;
}

export interface JailOptions {
  mustExist?: boolean;
  /** Refuse when the final component is a symlink (writes and deletes never follow links). */
  noFinalSymlink?: boolean;
  platform?: NodeJS.Platform;
}

/** Converts a native relative path to the `/`-separated form used in globs and output. */
export function toPosixRel(rel: string): string {
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

/**
 * Resolves a model-supplied path inside `root`. Throws {@link JailError} on any
 * escape: `..`, absolute paths outside root, symlinks that leave root, drive/UNC paths.
 */
export async function resolveInRoot(
  root: string,
  p: unknown,
  options: JailOptions = {},
): Promise<JailedPath> {
  const raw = checkLexical(p, options.platform);
  const realRoot = await realOrUndefined(root);
  if (realRoot === undefined) throw new JailError('workspace root does not exist');
  const abs = path.resolve(realRoot, raw);
  if (!isInside(realRoot, abs)) throw new JailError(`path is outside the workspace: ${raw}`);
  if (options.noFinalSymlink) {
    const st = await lstat(abs).catch(() => undefined);
    if (st?.isSymbolicLink()) throw new JailError(`refusing to follow a symlink: ${raw}`);
  }
  const { real, exists } = await realResolve(abs);
  if (!isInside(realRoot, real)) throw new JailError(`path escapes the workspace: ${raw}`);
  if (options.mustExist && !exists) throw new JailError(`not found: ${raw}`);
  return { abs: real, rel: toPosixRel(path.relative(realRoot, real)), exists, realRoot };
}

/** True when any segment of a root-relative path is `.git` (hooks there would run code). */
export function touchesGitDir(rel: string): boolean {
  return rel.split('/').some((s) => s.toLowerCase() === '.git');
}

function escapeRegex(s: string): string {
  return s.replace(/[|{}()[\]^$+.\\]/g, '\\$&');
}

/** Compiles a gitignore-like glob: `**` any depth, `*` and `?` within a segment. */
export function globToRegExp(glob: string, caseInsensitive = false): RegExp {
  let out = '';
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === '*' && g[i + 1] === '*') {
      const slash = g[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escapeRegex(c);
  }
  return new RegExp(`^${out}$`, caseInsensitive ? 'i' : '');
}

/**
 * True when the root-relative path (or one of its parent directories) matches a
 * forbidden glob. A glob without `/` matches a single segment at any depth.
 */
export function matchesForbidden(
  rel: string,
  globs: readonly string[],
  caseInsensitive = process.platform === 'win32',
): boolean {
  if (globs.length === 0) return false;
  const parts = rel
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  return globs.some((glob) => {
    const re = globToRegExp(glob, caseInsensitive);
    if (!glob.replace(/\/+$/, '').includes('/')) return parts.some((s) => re.test(s));
    return prefixes.some((p) => re.test(p));
  });
}
