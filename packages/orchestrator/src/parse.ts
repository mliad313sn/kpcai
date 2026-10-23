import { z } from 'zod';
import type { Verdict } from '@kernelpai/core';

/**
 * Model output is untrusted data (spec §6): these parsers never evaluate anything, they
 * only look for JSON objects and validate them with zod. A reply may quote JSON before its
 * real answer (review P2-F3), so every object is considered: the answer is taken only when
 * all the objects that validate agree, otherwise the reply is malformed.
 */

/** Removes Markdown code fences (```json … ```), keeping their content. */
export function stripFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?/g, '');
}

/**
 * Every top-level balanced `{…}` in `text` that parses as JSON, in order. Strings are
 * honoured, so braces inside quoted text do not end an object early; objects nested in a
 * parsed one are not listed separately.
 */
export function extractAllJson(text: string): unknown[] {
  const s = stripFences(text);
  const found: unknown[] = [];
  let start = s.indexOf('{');
  while (start !== -1) {
    const end = matchingBrace(s, start);
    let next = start + 1;
    if (end !== -1) {
      try {
        found.push(JSON.parse(s.slice(start, end + 1)) as unknown);
        next = end + 1;
      } catch {
        // Not JSON (e.g. prose with braces): try the next opening brace.
      }
    }
    start = s.indexOf('{', next);
  }
  return found;
}

/** The first JSON object in `text`, else undefined. */
export function extractJson(text: string): unknown {
  return extractAllJson(text)[0];
}

function matchingBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

export const VerdictSchema = z.object({
  approve: z.boolean(),
  issues: z
    .array(
      z.object({
        severity: z.enum(['major', 'minor']),
        text: z.string().min(1).max(4000),
      }),
    )
    .max(50)
    .default([]),
  summary: z.string().max(4000).default(''),
});

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The answer when every candidate agrees on `key`; the last one is returned (it is usually
 * the final answer after quoted examples). Conflicting candidates are malformed.
 */
function agreed<T>(values: T[], key: (v: T) => unknown, what: string): ParseResult<T> {
  const last = values.at(-1);
  if (last === undefined) return { ok: false, error: `no ${what} found` };
  const keys = new Set(values.map((v) => JSON.stringify(key(v))));
  if (keys.size > 1) return { ok: false, error: `conflicting ${what}s in one reply` };
  return { ok: true, value: last };
}

/** Critic output → `Verdict`, or why it is not one (none valid, or valid ones disagree). */
export function parseVerdict(text: string): ParseResult<Verdict> {
  const objects = extractAllJson(text);
  if (objects.length === 0) return { ok: false, error: 'no JSON object found' };
  const valid: Verdict[] = [];
  let firstError = '';
  for (const o of objects) {
    const parsed = VerdictSchema.safeParse(o);
    if (parsed.success) valid.push(parsed.data);
    else if (!firstError) {
      const first = parsed.error.issues[0];
      const where = first?.path.join('.') || 'root';
      firstError = `invalid verdict at ${where}: ${first?.message ?? 'invalid'}`;
    }
  }
  if (valid.length === 0) return { ok: false, error: firstError };
  return agreed(valid, (v) => v.approve, 'verdict');
}

const JudgeSchema = z.object({
  winner: z.union([z.literal(1), z.literal(2), z.literal('1'), z.literal('2')]),
  answer: z.string().max(200_000).optional(),
  reason: z.string().max(4000).optional(),
});

export interface JudgeVerdict {
  winner: 1 | 2;
  answer?: string;
  reason?: string;
}

/** Judge output → winner 1 or 2: JSON `{ "winner": 1 }` objects, else `winner: 2` lines. */
export function parseJudge(text: string): ParseResult<JudgeVerdict> {
  const json = extractAllJson(text).flatMap((o): JudgeVerdict[] => {
    const parsed = JudgeSchema.safeParse(o);
    if (!parsed.success) return [];
    const { winner, answer, reason } = parsed.data;
    return [
      {
        winner: Number(winner) as 1 | 2,
        ...(answer ? { answer } : {}),
        ...(reason ? { reason } : {}),
      },
    ];
  });
  if (json.length > 0) return agreed(json, (v) => v.winner, 'winner');
  const lines = [...stripFences(text).matchAll(/\bwinner\b\W{0,5}([12])\b/gi)].map(
    (m): JudgeVerdict => ({ winner: Number(m[1]) as 1 | 2 }),
  );
  return agreed(lines, (v) => v.winner, 'winner');
}

const VoteSchema = z.object({
  choice: z.string().min(1).max(500),
  reason: z.string().max(4000).optional(),
});

/** Voter output → normalised choice: JSON `{ "choice": "…" }` objects, else `choice: …` lines. */
export function parseVote(text: string): ParseResult<string> {
  const json = extractAllJson(text).flatMap((o) => {
    const parsed = VoteSchema.safeParse(o);
    return parsed.success ? [normalizeChoice(parsed.data.choice)] : [];
  });
  if (json.length > 0) return agreed(json, (v) => v, 'choice');
  const lines = [...stripFences(text).matchAll(/\bchoice\s*[:=]\s*"?([^"\n]+)"?/gi)]
    .map((m) => normalizeChoice(m[1] ?? ''))
    .filter((c) => c !== '');
  return agreed(lines, (v) => v, 'choice');
}

/** Case, surrounding punctuation and inner whitespace do not distinguish options. */
export function normalizeChoice(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`.*]+|[\s"'`.*]+$/g, '');
}
