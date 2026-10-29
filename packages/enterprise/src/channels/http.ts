/**
 * HTTP channels (ntfy, Pushover, Slack, Teams, Discord, Telegram): one JSON POST each.
 * The secret (webhook URL or token) is read from the environment here, at send time, and
 * goes only where the service expects it (the URL, a header or its token field). An outcome
 * is a status code or a word, never a response body or an error message, so nothing the
 * service echoes back (a URL with its token) can reach the journal or the feed.
 */
import type { Notification } from '@kernelpai/program';
import { endpointAllowed, type ChannelSpec } from './config.js';

export type Env = Readonly<Record<string, string | undefined>>;

export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, string>;
}

/** `ok`, a permanent failure, or a failure worth retrying. */
export interface Outcome {
  ok: boolean;
  retry: boolean;
  status: string;
}

type HttpSpec = Exclude<ChannelSpec, { type: 'markdown' | 'smtp' }>;

const JSON_HEADERS = { 'content-type': 'application/json' };

/** The request for one notice, or the reason it cannot be built (a missing secret). */
export function buildRequest(c: HttpSpec, n: Notification, env: Env): HttpRequest | string {
  const secret = env[c.secretEnv ?? ''];
  if (c.secretEnv && !secret) return 'no-secret';
  const p = n.payload;
  switch (c.type) {
    case 'slack':
    case 'teams':
    case 'discord':
      return { url: secret!, headers: JSON_HEADERS, body: p };
    case 'ntfy':
      return {
        url: c.endpoint,
        headers: secret ? { ...JSON_HEADERS, authorization: `Bearer ${secret}` } : JSON_HEADERS,
        body: { topic: c.topic, ...p },
      };
    case 'pushover': {
      const user = env[c.userEnv];
      if (!user) return 'no-secret';
      return { url: c.endpoint, headers: JSON_HEADERS, body: { token: secret!, user, ...p } };
    }
    case 'telegram':
      return {
        url: `${c.endpoint.replace(/\/+$/, '')}/bot${secret!}/sendMessage`,
        headers: JSON_HEADERS,
        body: { chat_id: c.chatId, ...p },
      };
  }
}

/** One POST; never throws, never returns text from the service or the error. */
export async function postJson(req: HttpRequest, timeoutMs: number): Promise<Outcome> {
  if (!endpointAllowed(req.url)) return { ok: false, retry: false, status: 'endpoint-refused' };
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.ok) return { ok: true, retry: false, status: String(res.status) };
    return {
      ok: false,
      retry: res.status === 429 || res.status >= 500,
      status: String(res.status),
    };
  } catch (err) {
    const timeout = err instanceof Error && err.name === 'TimeoutError';
    return { ok: false, retry: true, status: timeout ? 'timeout' : 'network' };
  }
}
