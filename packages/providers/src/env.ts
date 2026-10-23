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
