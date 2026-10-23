/**
 * Reading extension files (R-502, ADR-0033): skills, named agents, hooks and tickets. Files
 * in the repository are read inside the jail, never through a link that leaves it, never
 * from a forbidden zone; files in `$KPAI_HOME` are the user's own. Either way the text is
 * data: capped, stripped of control characters and secrets, never executed as instructions.
 */
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  JailError,
  inForbiddenZone,
  redact,
  resolveInRoot,
  stripControls,
  type ZoneSet,
} from '@kernelpai/tools';
import { parse as parseYaml } from 'yaml';

/** Where an extension comes from: the repository (untrusted) or `$KPAI_HOME` (the user's). */
export type Origin = 'repo' | 'home';

/** A file found for an extension: its text, where it is, and whether it was cut. */
export interface FoundFile {
  origin: Origin;
  /** Shown path: root-relative for the repository, `~kpai/…` for the home. */
  path: string;
  text: string;
  truncated: boolean;
}

/** One place files are looked for: a folder under the repository or under the home. */
export interface Place {
  origin: Origin;
  /** The repository root, or `$KPAI_HOME`. */
  base: string;
  /** Folder under `base`, `/`-separated. */
  dir: string;
}

const MAX_ENTRIES = 200;

/** Reads at most `limit` bytes of a regular file; undefined when it is not one. */
async function readCapped(
  abs: string,
  limit: number,
): Promise<{ text: string; truncated: boolean } | undefined> {
  const st = await lstat(abs).catch(() => undefined);
  if (!st?.isFile()) return undefined;
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, limit));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = redact(stripControls(buf.subarray(0, bytesRead).toString('utf8')));
    return { text, truncated: st.size > limit };
  } finally {
    await fh.close();
  }
}

/**
 * A file of the place, read with the place's rules: a repository file through the jail
 * (links that leave it and forbidden zones are refused); a home file only when it is a
 * regular file (never a link). Undefined when it is absent or refused.
 */
export async function readPlaceFile(
  place: Place,
  rel: string,
  limit: number,
  zones: ZoneSet,
): Promise<FoundFile | undefined> {
  const relPath = place.dir ? `${place.dir}/${rel}` : rel;
  if (place.origin === 'home') {
    const got = await readCapped(join(place.base, ...relPath.split('/')), limit);
    return got && { origin: 'home', path: `~kpai/${relPath}`, ...got };
  }
  const j = await resolveInRoot(place.base, relPath, { mustExist: true }).catch((e: unknown) => {
    if (e instanceof JailError) return undefined;
    throw e;
  });
  if (!j || inForbiddenZone(j.rel, zones)) return undefined;
  const got = await readCapped(j.abs, limit);
  return got && { origin: 'repo', path: j.rel, ...got };
}

/** Names in a place's folder (sorted, capped); empty when the folder is absent. */
export async function listPlace(place: Place, zones: ZoneSet): Promise<string[]> {
  const abs = join(place.base, ...place.dir.split('/'));
  if (place.origin === 'repo') {
    const j = await resolveInRoot(place.base, place.dir).catch(() => undefined);
    if (!j?.exists || inForbiddenZone(j.rel, zones)) return [];
  }
  const st = await lstat(abs).catch(() => undefined);
  if (!st?.isDirectory()) return [];
  const names = await readdir(abs).catch(() => []);
  return names.sort().slice(0, MAX_ENTRIES);
}

export interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
}

const FRONT = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const MAX_FRONT_CHARS = 8_000;

/**
 * `---` YAML front matter and the Markdown body after it (the Claude Code SKILL.md and
 * agent format). No aliases (no YAML bombs), size-capped; anything malformed is an error.
 */
export function frontMatter(text: string): FrontMatter {
  const m = FRONT.exec(text);
  if (!m) return { data: {}, body: text };
  const raw = m[1] ?? '';
  if (raw.length > MAX_FRONT_CHARS) throw new Error('front matter is too long');
  const data = parseYaml(raw, { maxAliasCount: 0, prettyErrors: false }) as unknown;
  if (data !== null && (typeof data !== 'object' || Array.isArray(data)))
    throw new Error('front matter is not a mapping');
  return { data: (data ?? {}) as Record<string, unknown>, body: text.slice(m[0].length) };
}

/** A list field: YAML list, or a comma-separated string (Claude Code writes both). */
export function listField(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const items = Array.isArray(v) ? v : String(v).split(',');
  return items
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, 64);
}

/** A short single-line text field, or undefined. */
export function textField(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const t = String(v).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

/** Extension names: lowercase letters, digits and hyphens (the Claude Code rule), ≤ 64. */
export const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Quotes untrusted text inside a tag so it cannot close the tag it is in. */
export function fence(tag: string, attrs: string, body: string): string {
  const safe = body.replace(new RegExp(`<\\/?${tag}`, 'gi'), (m) => m.replace('<', '&lt;'));
  return `<${tag} ${attrs}>\n${safe}\n</${tag}>`;
}

/** An attribute value with quotes and angle brackets escaped. */
export function attr(v: string): string {
  return v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
}
