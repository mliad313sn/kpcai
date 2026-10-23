/**
 * Glob matching with the semantics of packages/tools `matchesForbidden` (gitignore-like):
 * `**` any depth, `*` and `?` inside one segment; a glob without `/` matches any single
 * segment at any depth; `x/**` also covers the folder `x`. Kept local so this package
 * does not depend on packages/tools (work item WI-S7-02 proposes one shared export).
 */

function escapeRegex(s: string): string {
  return s.replace(/[|{}()[\]^$+.\\]/g, '\\$&');
}

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

function parts(rel: string): string[] {
  return rel
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
}

/** True when the root-relative path, or one of its parent folders, matches the glob. */
export function matchesGlob(rel: string, glob: string, caseInsensitive = false): boolean {
  const segs = parts(rel);
  const g = glob.replace(/\/+$/, '');
  const re = globToRegExp(g, caseInsensitive);
  if (!g.includes('/')) return segs.some((s) => re.test(s));
  const base = g.endsWith('/**') ? globToRegExp(g.slice(0, -3), caseInsensitive) : undefined;
  return segs.some((_, i) => {
    const p = segs.slice(0, i + 1).join('/');
    return re.test(p) || base?.test(p) === true;
  });
}

export function matchesAny(
  rel: string,
  globs: readonly string[],
  caseInsensitive = false,
): boolean {
  return globs.some((g) => matchesGlob(rel, g, caseInsensitive));
}

/** Longest run of literal characters, to refuse near-universal globs such as `*` or `**`. */
export function literalLength(glob: string): number {
  return Math.max(0, ...glob.split(/[*?/]+/).map((s) => s.length));
}
