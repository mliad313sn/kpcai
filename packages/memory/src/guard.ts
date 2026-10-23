/**
 * What may enter memory (ADR-0027). Memory is a persistence channel: whatever is stored is
 * sent again and again. So every fact, from a human or a model, is
 * - one printable line, capped in length, without comment markers that could fake provenance;
 * - refused when it names a path in a forbidden zone (the same `ZoneSet` as the tools);
 * - redacted with the tools' secret redaction before it is stored.
 */
import { DEFAULT_ZONES, redact, zoneHit, zoneSetFromGlobs, type ZoneSet } from '@kernelpai/tools';
import { MemoryError } from './types.js';

export const FACT_MAX_CHARS = 1000;

export interface Guard {
  /** Forbidden zones in force; default: the built-in zones. */
  zones?: ZoneSet;
  /** Secret values to redact besides token shapes (from the environment). */
  secrets?: readonly string[];
}

const DEFAULT_SET = zoneSetFromGlobs(DEFAULT_ZONES);

/** One line: controls and bidi overrides out, comment markers broken, spaces collapsed. */
export function cleanText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ')
      .replace(/<!--|-->/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Words of a fact that read like paths: they hold a slash, start with a dot or `~`, or end in an extension. */
function pathLike(word: string): boolean {
  return /[\\/]/.test(word) || /^[.~]/.test(word) || /^[\w.-]+\.[A-Za-z0-9]{1,10}$/.test(word);
}

/** Percent-decoded, up to three rounds (`%252Eenv`); the word as is when it does not decode. */
function decoded(word: string): string {
  let w = word;
  for (let i = 0; i < 3 && /%[0-9A-Fa-f]{2}/.test(w); i++) {
    try {
      w = decodeURIComponent(w);
    } catch {
      break;
    }
  }
  return w;
}

const SPLIT = /[\s`'"()[\]{}<>,;|*]+/;
/** Also cut on `=`, `:` and `@` (P4-F7: `file=.env`, `path:.env`, `user@host:.ssh/id_rsa`). */
const SPLIT_MORE = /[=:@]+/;

function candidates(text: string): string[] {
  const words = new Set<string>();
  for (const raw of text.split(SPLIT)) {
    const w = decoded(raw);
    for (const part of [w, ...w.split(SPLIT_MORE)]) {
      const t = part.replace(/[.:!?]+$/, '');
      if (!t) continue;
      const bare = t.replace(/^(?:~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\\/])+/, '');
      for (const c of bare && bare !== t ? [t, bare] : [t]) words.add(c).add(c.toLowerCase());
    }
  }
  return [...words];
}

/**
 * The forbidden zone a fact names, or undefined. Credential and added zones apply to any
 * word (`id_rsa`, `.env`); name heuristics (`*secret*`) only to words shaped like paths, so
 * "the secret-manager module" is not refused but `config/secrets.yaml` is. Words are also
 * cut on `=:@`, percent-decoded and lower-cased (P4-F7): a mention is a heuristic, and a
 * false refusal only asks the human to reword a fact.
 */
export function forbiddenMention(text: string, zones: ZoneSet = DEFAULT_SET): string | undefined {
  for (const word of candidates(text)) {
    const hit = zoneHit(word.replace(/\\/g, '/'), zones);
    if (hit && (hit.tier !== 'heuristic' || pathLike(word))) return hit.glob;
  }
  return undefined;
}

/** The text to store: cleaned, checked against the zones, then redacted. Throws when refused. */
export function screenFact(text: string, g: Guard = {}): string {
  const clean = cleanText(text);
  if (!clean) throw new MemoryError('invalid', 'a fact needs some text');
  if (clean.length > FACT_MAX_CHARS)
    throw new MemoryError('invalid', `a fact is at most ${FACT_MAX_CHARS} characters`);
  const zone = forbiddenMention(clean, g.zones ?? DEFAULT_SET);
  if (zone)
    throw new MemoryError(
      'refused',
      `the fact names a path in a forbidden zone (${zone}); memory never holds those`,
    );
  return redact(clean, g.secrets ?? []);
}
