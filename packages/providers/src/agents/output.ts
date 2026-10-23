/**
 * Parsing of an agent CLI's output. Everything here is untrusted: it is capped, stripped of
 * terminal escapes and control bytes, never evaluated, and read through own properties only
 * (a `__proto__` key in the JSON reaches nothing).
 */
import type { AgentDescriptor } from './descriptor.js';

/** Most characters of the agent's own summary kept (the diff is what gets reviewed). */
export const MAX_SUMMARY_CHARS = 8_000;

export interface AgentUsage {
  /** The cost the CLI reports (notional on a subscription: shown, never billed). */
  reportedUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ParsedOutput {
  text: string;
  usage: AgentUsage;
  /** The CLI flagged its answer as an error. */
  error: boolean;
  /** Stdout or stderr shows a rate limit or an exhausted plan. */
  rateLimited: boolean;
}

/** ANSI/OSC escapes, then every control byte but tab and newline, and bidi overrides. */
export function sanitize(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r\n/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
  );
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Own-property walk of a dotted path; undefined when any step is missing. */
export function pick(value: unknown, path: string | undefined): unknown {
  if (path === undefined) return undefined;
  let cur: unknown = value;
  for (const key of path.split('.')) {
    if (UNSAFE_KEYS.has(key)) return undefined;
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

function json(stdout: string, format: 'json' | 'jsonl'): unknown {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  if (format === 'json') return tryParse(stdout.trim());
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = tryParse(lines[i] as string);
    if (v !== undefined) return v;
  }
  return undefined;
}

function usageOf(d: AgentDescriptor, data: unknown): AgentUsage {
  const u: AgentUsage = {};
  const usd = count(pick(data, d.output.costUsd));
  const input = count(pick(data, d.output.inputTokens));
  const output = count(pick(data, d.output.outputTokens));
  if (usd !== undefined) u.reportedUsd = usd;
  if (input !== undefined) u.inputTokens = input;
  if (output !== undefined) u.outputTokens = output;
  return u;
}

/** True when the output or the exit code shows a rate limit or quota, per the descriptor. */
export function looksRateLimited(
  d: AgentDescriptor,
  out: string,
  exitCode: number | null,
): boolean {
  if (exitCode !== null && d.rateLimit.exitCodes.includes(exitCode)) return true;
  return d.rateLimit.patterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(out);
    } catch {
      return false;
    }
  });
}

/** Text, usage and error flag of a finished run (malformed JSON reads as plain text). */
export function parseOutput(
  d: AgentDescriptor,
  stdout: string,
  stderr: string,
  exitCode: number | null,
): ParsedOutput {
  const clean = sanitize(stdout);
  let text = clean;
  let usage: AgentUsage = {};
  let error = false;
  if (d.output.format !== 'text') {
    const data = json(clean, d.output.format);
    const t = pick(data, d.output.text);
    if (typeof t === 'string') text = sanitize(t);
    usage = usageOf(d, data);
    error = Boolean(pick(data, d.output.error));
  }
  const tail = `${clean.slice(-4_000)}\n${sanitize(stderr).slice(-4_000)}`;
  const failed = error || exitCode !== 0;
  return {
    text: cap(text.trim(), MAX_SUMMARY_CHARS),
    usage,
    error,
    rateLimited: failed && looksRateLimited(d, tail, exitCode),
  };
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
