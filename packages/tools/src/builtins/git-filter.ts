import { matchesForbidden } from '../paths.js';

/**
 * Keeps forbidden zones out of git read-tool output (review N2): the same globs
 * that make `fs.read` refuse `.env` also hide it from `git diff/status`.
 * Primary: `:(exclude,glob)` pathspecs. Defence in depth: output sections or
 * lines naming a forbidden path are dropped and counted.
 */
export interface ZoneFilter {
  globs: readonly string[];
  caseInsensitive: boolean;
}

/** Our glob → git `:(glob)` pathspecs. A glob without `/` matches a segment at any depth. */
function gitGlobs(glob: string): string[] {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (g === '') return [];
  if (!g.includes('/')) return [`**/${g}`, `**/${g}/**`];
  return g.endsWith('/**') ? [g, g.slice(0, -3)] : [g];
}

/** `:(exclude,glob[,icase])<pattern>` for every forbidden glob. */
export function excludePathspecs(zones: ZoneFilter): string[] {
  const magic = zones.caseInsensitive ? 'exclude,glob,icase' : 'exclude,glob';
  return zones.globs.flatMap(gitGlobs).map((p) => `:(${magic})${p}`);
}

function forbidden(p: string, zones: ZoneFilter): boolean {
  const clean = p.replace(/^"|"$/g, '');
  return matchesForbidden(clean, zones.globs, zones.caseInsensitive);
}

function omitted(n: number): string {
  return n === 0 ? '' : `[${n} entr${n === 1 ? 'y' : 'ies'} in forbidden zones omitted]\n`;
}

/** Drops `diff --git` sections whose a/ or b/ path is in a forbidden zone. */
export function filterDiff(out: string, zones: ZoneFilter): string {
  if (zones.globs.length === 0) return out;
  const parts = out.split(/^(?=diff --git )/m);
  let dropped = 0;
  const kept = parts.filter((part) => {
    const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/m.exec(part.split('\n')[0] ?? '');
    if (!part.startsWith('diff --git ') || !m) return true;
    const hit = forbidden(m[1] as string, zones) || forbidden(m[2] as string, zones);
    if (hit) dropped += 1;
    return !hit;
  });
  return kept.join('') + omitted(dropped);
}

/** Drops porcelain status lines (`XY path` / `XY old -> new`) naming a forbidden path. */
export function filterStatus(out: string, zones: ZoneFilter): string {
  if (zones.globs.length === 0) return out;
  let dropped = 0;
  const kept = out.split('\n').filter((line) => {
    if (line.startsWith('## ') || line.length < 4) return true;
    const hit = line
      .slice(3)
      .split(' -> ')
      .some((p) => forbidden(p, zones));
    if (hit) dropped += 1;
    return !hit;
  });
  return kept.join('\n') + omitted(dropped);
}
