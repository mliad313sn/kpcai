import { createHash } from 'node:crypto';

/** Default cap on a tool result handed back to the model (32 kB). */
export const DEFAULT_MAX_RESULT_BYTES = 32 * 1024;
/** Cap on the result preview stored in the journal. */
export const JOURNAL_PREVIEW_CHARS = 200;

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = Math.max(0, maxBytes);
  // Step back over UTF-8 continuation bytes (10xxxxxx).
  while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end--;
  const kept = buf.subarray(0, end).toString('utf8');
  return { text: `${kept}\n[truncated: ${buf.length - end} more bytes]`, truncated: true };
}

/**
 * Removes C0/C1 control characters and escape sequences (keeps tab and newline) so
 * text built from untrusted input can be shown in a confirmation prompt (ADR-0015).
 */
export function stripControls(text: string): string {
  /* eslint-disable no-control-regex -- stripping control characters is the point */
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  /* eslint-enable no-control-regex */
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A journal-safe summary of a long text: short preview, size and hash, never the whole. */
export function summarize(
  text: string,
  previewChars = JOURNAL_PREVIEW_CHARS,
): Record<string, unknown> {
  if (text.length <= previewChars) return { preview: text, chars: text.length };
  return { preview: `${text.slice(0, previewChars)}…`, chars: text.length, sha256: sha256(text) };
}

/** Input fields that carry file contents: journaled as size + hash only, never the text. */
const CONTENT_KEYS = new Set(['content', 'patch', 'diff', 'body']);

/**
 * Journal form of a tool input: content-bearing fields become `{ chars, sha256 }`,
 * other long strings a short preview.
 */
export function summarizeInput(value: unknown, depth = 0, key = ''): unknown {
  if (typeof value === 'string') {
    if (CONTENT_KEYS.has(key)) return { chars: value.length, sha256: sha256(value) };
    return value.length > JOURNAL_PREVIEW_CHARS ? summarize(value) : value;
  }
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => summarizeInput(v, depth + 1, key));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value).slice(0, 50)) {
    out[k] = summarizeInput(v, depth + 1, k);
  }
  return out;
}
