/**
 * Outbound channels, `$KPAI_HOME/enterprise/channels.json` (R-5E9, Q-11, ADR-0036). Strict:
 * an unknown key is an error. The file names channels, endpoints and the **names** of the
 * environment variables that hold secrets; secrets themselves are read from the
 * environment at send time and never written, journaled or logged.
 *
 * Q-11 default: only the local Markdown/RSS file and SMTP to a loopback host may carry
 * notices. Any other channel (chat webhooks, push services, remote SMTP) is refused unless
 * the Sponsor sets `allowThirdParty: true` in this file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const Env = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/, 'an environment variable name');
const Email = z
  .string()
  .max(200)
  .regex(/^[^\s<>@,;"]+@[^\s<>@,;"]+$/, 'an e-mail address');
const Url = z.url({ protocol: /^https?$/ }).max(500);

const base = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  /** Opt-in: a short redacted summary (asks, top risk) instead of counts only. */
  summary: z.boolean().default(false),
  enabled: z.boolean().default(true),
};

export const ChannelSpecSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('markdown') }),
  z.strictObject({
    ...base,
    type: z.literal('smtp'),
    host: z.string().min(1).max(200),
    port: z.number().int().min(1).max(65_535).default(25),
    /** Implicit TLS (port 465). Required for a non-loopback host. */
    secure: z.boolean().default(false),
    from: Email,
    to: z.array(Email).min(1).max(20),
    userEnv: Env.optional(),
    secretEnv: Env.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.enum(['slack', 'teams', 'discord']),
    /** The webhook URL is the secret: it is read from this variable. */
    secretEnv: Env,
  }),
  z.strictObject({
    ...base,
    type: z.literal('ntfy'),
    endpoint: Url.default('https://ntfy.sh'),
    topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    secretEnv: Env.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('pushover'),
    endpoint: Url.default('https://api.pushover.net/1/messages.json'),
    secretEnv: Env,
    userEnv: Env,
  }),
  z.strictObject({
    ...base,
    type: z.literal('telegram'),
    endpoint: Url.default('https://api.telegram.org'),
    secretEnv: Env,
    chatId: z.string().regex(/^-?[0-9]{1,20}$|^@[A-Za-z0-9_]{1,64}$/),
  }),
]);
export type ChannelSpec = z.infer<typeof ChannelSpecSchema>;

export const ChannelsFileSchema = z.strictObject({
  version: z.literal(1).default(1),
  /** Q-11: the Sponsor's consent for notices leaving to third-party services. */
  allowThirdParty: z.boolean().default(false),
  /** Loopback link to KP Studio put in notices (`notify.ts safeLink`). */
  link: Url.optional(),
  locale: z.enum(['en', 'fr']).default('en'),
  retry: z
    .strictObject({
      attempts: z.number().int().min(1).max(6).default(3),
      baseMs: z.number().int().min(1).max(60_000).default(1_000),
    })
    .default({ attempts: 3, baseMs: 1_000 }),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  channels: z.array(ChannelSpecSchema).max(20).default([]),
});
export type ChannelsFile = z.infer<typeof ChannelsFileSchema>;

export const CHANNELS_FILE = 'channels.json';

const MARKDOWN: ChannelSpec = { id: 'markdown', type: 'markdown', summary: false, enabled: true };

/** The file's channels; the Markdown/RSS channel is always there (local, Q-11 default). */
export function loadChannels(path: string): ChannelsFile {
  const raw: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const f = ChannelsFileSchema.parse(raw);
  const ids = new Set<string>();
  for (const c of f.channels) {
    if (ids.has(c.id)) throw new Error(`duplicate channel id ${c.id}`);
    ids.add(c.id);
  }
  return f.channels.some((c) => c.type === 'markdown')
    ? f
    : { ...f, channels: [MARKDOWN, ...f.channels] };
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** Local per Q-11: the Markdown file, or SMTP to this machine. */
export function isLocal(c: ChannelSpec): boolean {
  return c.type === 'markdown' || (c.type === 'smtp' && isLoopbackHost(c.host));
}

/** Why a channel may not carry a notice, or undefined when it may. */
export function refusal(c: ChannelSpec, f: ChannelsFile): string | undefined {
  if (!c.enabled) return 'disabled';
  if (!isLocal(c) && !f.allowThirdParty) return 'third-party channel not allowed (Q-11)';
  if (c.type === 'smtp' && !isLoopbackHost(c.host) && !c.secure) return 'remote SMTP needs TLS';
  return undefined;
}

/** HTTPS anywhere; plain HTTP only to this machine. */
export function endpointAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname));
  } catch {
    return false;
  }
}
