/**
 * The inline provenance of a fact: a trailing HTML comment, invisible when the Markdown is
 * rendered and readable in the raw file.
 *
 *   - Use pnpm, never npm. <!-- kpai id=m-1a2b3c4d source=human date=2026-10-23 -->
 *   - Tests sit next to sources. <!-- kpai id=m-9f8e7d6c source=mock/m1 date=2026-10-23
 *     evidence=run:4c1…,node:code confirmed=2026-10-24 local-only -->
 *
 * Attributes are `key=value` or the flag `local-only`. Values are percent-encoded outside
 * `[A-Za-z0-9._:/@+=-]`, so a value never holds a space, a comma or `-->`.
 */
import type { Provenance } from './types.js';

export const COMMENT_RE = /<!--\s*kpai\b([^]*?)-->\s*$/;
const SAFE = /[^A-Za-z0-9._:/@+=-]/g;
const ID_RE = /^m-[a-z0-9]{4,32}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `provider/model`: a descriptor id (lowercase, digits, dashes), then the model id. */
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
/** `run:<id>`, `node:<id>`, `event:<seq>`: printable, no space, no brackets or quotes. */
// eslint-disable-next-line no-control-regex
const EVIDENCE_RE = /^(?:run|node|event):[^\s<>[\]`"'\\\u0000-\u001f\u007f-\u009f]{1,200}$/u;
const KNOWN = new Set(['id', 'source', 'date', 'evidence', 'confirmed', 'edited']);

export function encodeValue(v: string): string {
  return v.replace(SAFE, (c) =>
    [...Buffer.from(c, 'utf8')]
      .map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`)
      .join(''),
  );
}

export function decodeValue(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function isFactId(id: string): boolean {
  return ID_RE.test(id);
}

export function isDay(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  // A real day: V8 reads 2026-02-30 as March 2nd, so the day must read back the same.
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** A valid source: `human`, `unknown`, or a model as `provider/model` (P4-F1). */
export function isSource(s: string): boolean {
  return s === 'human' || s === 'unknown' || SOURCE_RE.test(s);
}

export function isEvidence(e: string): boolean {
  return EVIDENCE_RE.test(e);
}

/** A value from a file, safe to quote in a problem message: short and encoded. */
function shown(v: string): string {
  return encodeValue(v.slice(0, 40));
}

export interface ParsedAttrs {
  id?: string;
  provenance: Provenance;
  extra: Record<string, string>;
  problems: string[];
}

/** The attributes of a `kpai` comment; anything odd is reported, never dropped. */
export function parseAttrs(body: string): ParsedAttrs {
  const out: ParsedAttrs = {
    provenance: { source: 'unknown', date: '', evidence: [], localOnly: false },
    extra: {},
    problems: [],
  };
  const p = out.provenance;
  for (const token of body.trim().split(/\s+/).filter(Boolean)) {
    if (token === 'local-only') {
      p.localOnly = true;
      continue;
    }
    const eq = token.indexOf('=');
    if (eq <= 0) {
      out.problems.push(`unknown provenance flag "${shown(token)}" kept as is`);
      out.extra[token] = '';
      continue;
    }
    const key = token.slice(0, eq);
    const raw = token.slice(eq + 1);
    if (!KNOWN.has(key)) {
      out.problems.push(`unknown provenance attribute "${shown(key)}" kept as is`);
      out.extra[key] = raw;
      continue;
    }
    setKnown(out, key, raw);
  }
  if (p.source === 'unknown') out.problems.push('provenance has no source: treated as untrusted');
  return out;
}

/**
 * Known attributes are validated as they are read (P4-F1): a source is `human` or
 * `provider/model`, days are `YYYY-MM-DD`, evidence is `run:|node:|event:` and printable.
 * An invalid value is dropped and reported, so no file can put arbitrary text (decoded
 * newlines, `<`, a fake block) into a prompt or a journal through its provenance.
 */
function setKnown(out: ParsedAttrs, key: string, raw: string): void {
  const p = out.provenance;
  const v = decodeValue(raw);
  const bad = (what: string): void =>
    void out.problems.push(`${key} "${shown(v)}" is not ${what}; dropped`);
  if (key === 'id') out.id = v;
  else if (key === 'source') {
    if (v && isSource(v)) p.source = v;
    else bad('human or provider/model');
  } else if (key === 'evidence') {
    for (const e of raw.split(',').filter(Boolean).map(decodeValue)) {
      if (isEvidence(e)) p.evidence.push(e);
      else out.problems.push(`evidence "${shown(e)}" is not run:, node: or event:; dropped`);
    }
  } else if (!isDay(v)) bad('YYYY-MM-DD');
  else if (key === 'date') p.date = v;
  else if (key === 'confirmed') p.confirmed = v;
  else p.edited = v;
}

/** The comment for a fact, attributes in a fixed order (stable diffs). */
export function formatAttrs(
  id: string,
  p: Provenance,
  extra: Readonly<Record<string, string>> = {},
): string {
  const parts = [`id=${encodeValue(id)}`, `source=${encodeValue(p.source)}`];
  if (p.date) parts.push(`date=${encodeValue(p.date)}`);
  if (p.evidence.length) parts.push(`evidence=${p.evidence.map(encodeValue).join(',')}`);
  if (p.confirmed) parts.push(`confirmed=${encodeValue(p.confirmed)}`);
  if (p.edited) parts.push(`edited=${encodeValue(p.edited)}`);
  if (p.localOnly) parts.push('local-only');
  for (const [k, v] of Object.entries(extra)) parts.push(v === '' ? k : `${k}=${v}`);
  return `<!-- kpai ${parts.join(' ')} -->`;
}
