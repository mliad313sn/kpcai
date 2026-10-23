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
  return DATE_RE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
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
      out.problems.push(`unknown provenance flag "${token.slice(0, 40)}" kept as is`);
      out.extra[token] = '';
      continue;
    }
    const key = token.slice(0, eq);
    const raw = token.slice(eq + 1);
    if (!KNOWN.has(key)) {
      out.problems.push(`unknown provenance attribute "${key.slice(0, 40)}" kept as is`);
      out.extra[key] = raw;
      continue;
    }
    setKnown(out, key, raw);
  }
  if (p.source === 'unknown') out.problems.push('provenance has no source: treated as untrusted');
  if (p.date && !isDay(p.date))
    out.problems.push(`date "${p.date.slice(0, 40)}" is not YYYY-MM-DD`);
  return out;
}

function setKnown(out: ParsedAttrs, key: string, raw: string): void {
  const p = out.provenance;
  if (key === 'id') out.id = decodeValue(raw);
  else if (key === 'source') p.source = decodeValue(raw) || 'unknown';
  else if (key === 'date') p.date = decodeValue(raw);
  else if (key === 'evidence') p.evidence = raw.split(',').filter(Boolean).map(decodeValue);
  else if (key === 'confirmed') p.confirmed = decodeValue(raw);
  else p.edited = decodeValue(raw);
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
