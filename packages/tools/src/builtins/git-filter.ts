import { ENV_TEMPLATES, inForbiddenZone, type ZoneSet } from '../zones.js';

/**
 * Keeps forbidden zones out of git read-tool output (review N2): the same zone set
 * that makes `fs.read` refuse `.env` also hides it from `git diff/status`.
 * Primary: `:(exclude,glob)` pathspecs. Defence in depth: output sections or
 * lines naming a forbidden path are dropped and counted.
 *
 * Git cannot read files here, so `*.key` stays name-based (a Keynote document is
 * hidden from git output, which would only say "Binary files differ" anyway). While a
 * pack relaxation is in force the heuristic globs are not passed as pathspecs (git has
 * no "except under" form); the output filter, which knows the relaxation, drops them.
 * Credential and added zones keep both layers at all times.
 */
export type ZoneFilter = ZoneSet;

/**
 * Our glob → git `:(glob)` pathspecs. A glob without `/` matches a segment at any depth.
 * Like `matchesForbidden`, a glob also covers everything under a matching directory
 * (the `*secret*` default hides `config/secrets/prod.yaml`, review NF-1).
 */
function gitGlobs(glob: string): string[] {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (g === '') return [];
  if (!g.includes('/')) return [`**/${g}`, `**/${g}/**`];
  return g.endsWith('/**') ? [g, g.slice(0, -3)] : [g, `${g}/**`];
}

/**
 * `.env.*` minus the template names, as wildmatch segment globs: `.env.X` for every X
 * that is not `example`, `sample` or `template` (`.env.`, `.env.[!est]*`, then for each
 * word its proper prefixes, one-character deviations and longer forms).
 */
export function envCredentialGlobs(): string[] {
  const words = ENV_TEMPLATES.map((t) => t.slice('.env.'.length));
  const firsts = words.map((w) => w[0] as string);
  if (new Set(firsts).size !== firsts.length || words.some((w) => !/^[a-z]+$/.test(w))) {
    return ['.env.*']; // cannot express exactly: hide every `.env.*` (stricter)
  }
  const out = ['.env.', `.env.[!${firsts.join('')}]*`];
  for (const w of words) {
    for (let i = 1; i < w.length; i++)
      out.push(`.env.${w.slice(0, i)}`, `.env.${w.slice(0, i)}[!${w[i]}]*`);
    out.push(`.env.${w}?*`);
  }
  return out;
}

/** `:(exclude,glob[,icase])<pattern>` for every zone of the set (see above for heuristics). */
export function excludePathspecs(zones: ZoneFilter): string[] {
  const magic = zones.caseInsensitive ? 'exclude,glob,icase' : 'exclude,glob';
  const relaxing = zones.relaxed.length > 0;
  const globs = zones.entries
    .filter((e) => !(relaxing && e.tier === 'heuristic'))
    .flatMap((e) =>
      e.tier === 'credential' && e.glob === '.env.*' ? envCredentialGlobs() : [e.glob],
    );
  return [...new Set(globs.flatMap(gitGlobs))].map((p) => `:(${magic})${p}`);
}

function forbidden(p: string, zones: ZoneFilter): boolean {
  const clean = p.replace(/^"|"$/g, '');
  return inForbiddenZone(clean, zones);
}

function omitted(n: number): string {
  return n === 0 ? '' : `[${n} entr${n === 1 ? 'y' : 'ies'} in forbidden zones omitted]\n`;
}

/**
 * Drops `diff --git` sections whose a/ or b/ path is in a forbidden zone. A section
 * whose header cannot be parsed is dropped too: fail closed (review NF-1).
 */
export function filterDiff(out: string, zones: ZoneFilter): string {
  if (zones.entries.length === 0) return out;
  const parts = out.split(/^(?=diff --git )/m);
  let dropped = 0;
  const kept = parts.filter((part) => {
    const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/m.exec(part.split('\n')[0] ?? '');
    if (!part.startsWith('diff --git ')) return true;
    const hit = !m || forbidden(m[1] as string, zones) || forbidden(m[2] as string, zones);
    if (hit) dropped += 1;
    return !hit;
  });
  return kept.join('') + omitted(dropped);
}

/** Drops porcelain status lines (`XY path` / `XY old -> new`) naming a forbidden path. */
export function filterStatus(out: string, zones: ZoneFilter): string {
  if (zones.entries.length === 0) return out;
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
