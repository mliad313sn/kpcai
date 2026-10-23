import { z } from 'zod';
import type { Verdict } from '@kernelpai/core';

/**
 * Model output is untrusted data (spec §6): these parsers never evaluate anything, they
 * only look for one JSON object and validate it with zod.
 */

/** Removes Markdown code fences (```json … ```), keeping their content. */
export function stripFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?/g, '');
}

/**
 * The first balanced `{…}` in `text` that parses as JSON, else undefined. Strings are
 * honoured, so braces inside quoted text do not end the object early.
 */
export function extractJson(text: string): unknown {
  const s = stripFences(text);
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    const end = matchingBrace(s, start);
    if (end === -1) return undefined;
    try {
      return JSON.parse(s.slice(start, end + 1)) as unknown;
    } catch {
      // Not JSON (e.g. prose with braces): try the next opening brace.
    }
  }
  return undefined;
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

/** Critic output → `Verdict`, or why it is not one. */
export function parseVerdict(text: string): ParseResult<Verdict> {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, error: 'no JSON object found' };
  const parsed = VerdictSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join('.') || 'root';
    return { ok: false, error: `invalid verdict at ${where}: ${first?.message ?? 'invalid'}` };
  }
  return { ok: true, value: parsed.data };
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

/** Judge output → winner 1 or 2: JSON `{ "winner": 1 }`, else a `winner: 2` line. */
export function parseJudge(text: string): ParseResult<JudgeVerdict> {
  const parsed = JudgeSchema.safeParse(extractJson(text));
  if (parsed.success) {
    const { winner, answer, reason } = parsed.data;
    return {
      ok: true,
      value: {
        winner: Number(winner) as 1 | 2,
        ...(answer ? { answer } : {}),
        ...(reason ? { reason } : {}),
      },
    };
  }
  const m = /\bwinner\b\W{0,5}([12])\b/i.exec(stripFences(text));
  if (m) return { ok: true, value: { winner: Number(m[1]) as 1 | 2 } };
  return { ok: false, error: 'no winner (1 or 2) found' };
}

const VoteSchema = z.object({
  choice: z.string().min(1).max(500),
  reason: z.string().max(4000).optional(),
});

/** Voter output → normalised choice: JSON `{ "choice": "…" }`, else a `choice: …` line. */
export function parseVote(text: string): ParseResult<string> {
  const parsed = VoteSchema.safeParse(extractJson(text));
  if (parsed.success) return { ok: true, value: normalizeChoice(parsed.data.choice) };
  const m = /\bchoice\s*[:=]\s*"?([^"\n]+)"?/i.exec(stripFences(text));
  if (m?.[1] && normalizeChoice(m[1])) return { ok: true, value: normalizeChoice(m[1]) };
  return { ok: false, error: 'no choice found' };
}

/** Case, surrounding punctuation and inner whitespace do not distinguish options. */
export function normalizeChoice(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`.*]+|[\s"'`.*]+$/g, '');
}
