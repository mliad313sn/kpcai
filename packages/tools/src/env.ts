export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Variable names that look like credentials. Matching is case-insensitive because
 * Windows environment names are. Covers `*_API_KEY`, `*_API_TOKEN`, `*_TOKEN`,
 * `*SECRET*`, `*PASSWORD*`, cloud credential families and agent sockets.
 */
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /(^|_)API_?(KEY|TOKEN)S?($|_)/i,
  /(^|_)(ACCESS_?|AUTH_?|SESSION_?|REFRESH_?|BEARER_?)?TOKENS?($|_)/i,
  /SECRET/i,
  /PASSW(OR)?D/i,
  /(^|_)CREDENTIALS?($|_)/i,
  /(^|_)PRIVATE_?KEY/i,
  /_KEY$/i,
  /^(AWS|AZURE|GCP|GOOGLE_APPLICATION|GH|GITHUB|GITLAB|NPM_CONFIG__AUTH|VAULT)_/i,
  /^SSH_AUTH_SOCK$/i,
  /^KPAI_.*(KEY|TOKEN|SECRET)/i,
];

export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERNS.some((re) => re.test(name));
}

/** Copy of `env` without credential-looking variables (for child processes). */
export function scrubEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || isSecretName(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Values of credential-looking variables long enough to be worth redacting. */
export function secretValues(env: Env): string[] {
  const vals: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v.length >= 8 && isSecretName(k)) vals.push(v);
  }
  return vals.sort((a, b) => b.length - a.length);
}

const TOKEN_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** Replaces known token shapes and the given secret values with `[redacted]`. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}
