import type { ProviderDescriptor } from '@kernelpai/core';

export type Env = Readonly<Record<string, string | undefined>>;

/** Resolves the base URL: env override first, then the descriptor default. */
export function resolveBaseUrl(d: ProviderDescriptor, env: Env): string | undefined {
  const fromEnv = d.baseUrlEnv ? env[d.baseUrlEnv]?.trim() : undefined;
  const raw = fromEnv || d.baseUrl;
  if (!raw) return undefined;
  const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  return new URL(withScheme).toString().replace(/\/$/, '');
}

export function resolveApiKey(d: ProviderDescriptor, env: Env): string | undefined {
  if (!d.auth) return undefined;
  const v = env[d.auth.env]?.trim();
  return v ? v : undefined;
}

/** True when the URL's host is this machine: 127.0.0.0/8, ::1 (or its v4-mapped form), localhost. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '[::1]') return true;
  // WHATWG URL normalises IPv4 (including 0x7f.1, 2130706433...) to dotted decimal.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // [::ffff:127.x.y.z] is normalised to [::ffff:7fxx:yyzz].
  return /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}

/** True when a credential may be sent to this URL: HTTPS, or plain HTTP on loopback. */
export function mayCarryCredentials(url: string): boolean {
  return url.startsWith('https://') || isLoopbackUrl(url);
}

/**
 * Review F8: a `kind: local` provider must resolve to this machine, whatever the
 * env override says, or prompts would leave the host while being labelled local.
 * An undefined base URL means the SDK's public default endpoint, so it is not local.
 * Returns the reason the provider is refused, or undefined when it is fine.
 */
export function localHostProblem(
  d: ProviderDescriptor,
  baseUrl: string | undefined,
): string | undefined {
  if (d.kind !== 'local') return undefined;
  if (baseUrl !== undefined && isLoopbackUrl(baseUrl)) return undefined;
  const where = baseUrl ?? "the SDK's default endpoint";
  const via = d.baseUrlEnv ? ` (check ${d.baseUrlEnv})` : '';
  return `host is not local: ${where} is not a loopback address${via}; declare kind: cloud in a user descriptor to use a remote server`;
}
