/**
 * The local channel (Q-11 default, R-5E9): every notice is appended to
 * `enterprise/notifications.jsonl`, and the last 50 are rendered as `notifications.md` and an
 * RSS 2.0 feed `notifications.xml` that a local reader can follow. Files are private (0600).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { Notification } from '@kernelpai/program';
import { writeAtomic } from '../store.js';
import type { Outcome } from './http.js';

interface Entry {
  at: string;
  title: string;
  text: string;
  link?: string;
}

const KEEP = 50;

const xml = (s: string): string =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );

function entries(path: string): Entry[] {
  if (!existsSync(path)) return [];
  const out: Entry[] = [];
  for (const line of readFileSync(path, 'utf8')
    .split('\n')
    .slice(-KEEP - 1)) {
    try {
      if (line) out.push(JSON.parse(line) as Entry);
    } catch {
      // A torn last line after a crash is skipped.
    }
  }
  return out.slice(-KEEP);
}

function rss(items: Entry[]): string {
  const body = [...items]
    .reverse()
    .map(
      (e) =>
        `  <item><title>${xml(e.title)}</title><pubDate>${new Date(e.at).toUTCString()}</pubDate><description>${xml(e.text)}</description>${e.link ? `<link>${xml(e.link)}</link>` : ''}</item>`,
    )
    .join('\n');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0"><channel>',
    '  <title>KP Studio notifications</title>',
    '  <description>Local notices from the KP Studio daemon</description>',
    body,
    '</channel></rss>',
    '',
  ].join('\n');
}

function markdown(items: Entry[]): string {
  const out = ['# KP Studio notifications', ''];
  for (const e of [...items].reverse()) out.push(`## ${e.at} — ${e.title}`, '', e.text, '');
  return out.join('\n');
}

/** Appends one notice and re-renders the Markdown and RSS views. */
export function writeLocal(dir: string, n: Notification, now: Date): Outcome {
  const text = n.payload['text'] ?? '';
  const [first, ...rest] = text.replace(/^# /, '').split('\n');
  const entry: Entry = {
    at: now.toISOString(),
    title: (first ?? '').slice(0, 200),
    text: rest.join('\n').trim(),
  };
  const jsonl = `${dir}/notifications.jsonl`;
  appendFileSync(jsonl, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  const items = entries(jsonl);
  writeAtomic(`${dir}/notifications.md`, markdown(items));
  writeAtomic(`${dir}/notifications.xml`, rss(items));
  return { ok: true, retry: false, status: 'written' };
}
