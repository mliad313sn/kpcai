/**
 * Outbound notifications (D-026 §4, ADR-0031 §6): a report rendered for one channel.
 * Pure: no network. What leaves the machine is a summary and a link, never code, secrets
 * or local-only memory. Channel secrets (SMTP password, webhook URL, tokens) are not
 * part of the message: the sender reads them from env or the keychain at send time.
 */
import type { Report, ReportLine } from './report.js';

export type ChannelKind =
  'email' | 'ntfy' | 'pushover' | 'slack' | 'teams' | 'discord' | 'telegram' | 'markdown';

/** Bodies are cut to fit each channel's limit (Discord 2,000; Pushover 1,024…). */
export const CHANNEL_LIMITS: Record<ChannelKind, number> = {
  email: 20_000,
  ntfy: 4_000,
  pushover: 1_024,
  slack: 3_000,
  teams: 20_000,
  discord: 2_000,
  telegram: 4_096,
  markdown: 50_000,
};

export interface Notification {
  channel: ChannelKind;
  /** The provider payload minus credentials and endpoint (added by the sender). */
  payload: Record<string, string>;
  /** Lines dropped by the redaction rules (counted, never listed). */
  redacted: number;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
];

/** Code-shaped text, anywhere in the line (model text arrives quoted: "po: \"const x…\""). */
const CODE_SIGNS: RegExp[] = [
  /^\s*(?:[+-]{1,3}\s|@@|diff --git|#include|<\?php|\$\s)/,
  /\b(?:import|export|const|let|var|def|class|function)\s+[\w{*]/,
  /\b(?:require|eval|exec|system|spawn)\s*\(/,
  /\brm\s+-[rf]+\b|\bsudo\s|\bcurl\s+\S+\s*\|/,
  /[;{}]\s*["»”']?\s*$/,
  /=>/,
];

/** Redacts secret-shaped text; returns undefined when the line is code and must go. */
export function redactLine(text: string): string | undefined {
  if (/-----BEGIN [A-Z ]+-----/.test(text) || /```/.test(text)) return undefined;
  if (CODE_SIGNS.some((p) => p.test(text))) return undefined;
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[redacted]');
  return out.replace(/\s+/g, ' ').trim();
}

/** The lines of a report that may leave the machine, after redaction. */
export function outboundLines(r: Report): { lines: string[]; redacted: number } {
  const lines: string[] = [];
  let redacted = 0;
  for (const sec of r.sections) {
    const kept = sec.lines
      .map((l) => keep(l))
      .filter((x): x is string => {
        if (x === undefined) redacted += 1;
        return x !== undefined;
      });
    if (kept.length) lines.push(`${sec.title}:`, ...kept.map((k) => `- ${k}`));
  }
  return { lines, redacted };
}

function keep(l: ReportLine): string | undefined {
  if (l.localOnly) return undefined;
  const text = redactLine(l.text);
  if (text === undefined) return undefined;
  return l.quoted ? cut(text, 200) : text;
}

function cut(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * Only a loopback link (`kpai studio` on the machine) until the phase 6 remote layer
 * (R-6E1) exists. Anything else is dropped.
 */
export function safeLink(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    return loopback && (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Renders a report for one channel. */
export function renderNotification(r: Report, channel: ChannelKind, link?: string): Notification {
  const { lines, redacted } = outboundLines(r);
  const title = cut(redactLine(r.title) ?? r.programId, 200);
  const head = redactLine(r.headline) ?? '';
  const url = safeLink(link);
  const tail = url ? `${r.link}\n${url}` : r.link;
  const limit = CHANNEL_LIMITS[channel];
  const body = fit([head, '', ...lines, '', tail].join('\n'), limit - title.length - 4);
  return { channel, payload: payload(channel, title, body, url), redacted };
}

/** Cuts at a line boundary and says so, keeping the closing link. */
function fit(body: string, limit: number): string {
  if (body.length <= limit) return body;
  const mark = '\n…';
  const cutAt = body.lastIndexOf('\n', limit - mark.length);
  return `${body.slice(0, cutAt > 0 ? cutAt : limit - mark.length)}${mark}`;
}

function payload(
  c: ChannelKind,
  title: string,
  body: string,
  url: string | undefined,
): Record<string, string> {
  const withUrl = (p: Record<string, string>, key: string): Record<string, string> =>
    url ? { ...p, [key]: url } : p;
  switch (c) {
    case 'email':
      return { subject: title, text: body };
    case 'ntfy':
      return withUrl({ title, message: body }, 'click');
    case 'pushover':
      return withUrl({ title, message: body }, 'url');
    case 'slack':
    case 'teams':
      return { text: `${title}\n${body}` };
    case 'discord':
      return { content: `${title}\n${body}` };
    case 'telegram':
      return { text: `${title}\n${body}` };
    case 'markdown':
      return { text: `# ${title}\n\n${body}\n` };
  }
}
