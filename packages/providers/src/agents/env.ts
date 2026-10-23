import type { Env } from '../env.js';

/**
 * Names that look like a credential: removed from an agent's environment whatever their
 * origin, so KernelPAI's own keys (or any other API key the parent holds) never reach a
 * child process that runs untrusted model output as code.
 */
const CREDENTIAL = /(_API_KEY|_API_TOKEN|_AUTH_TOKEN|_ACCESS_KEY|_SECRET|_SECRET_KEY)$/i;
/**
 * Other credential families an agent's shell would otherwise read and could quote to its
 * cloud model (WP7-F9): `GITHUB_TOKEN`, `AWS_SESSION_TOKEN`, `NPM_TOKEN`, `*_PASSWORD`,
 * `*_PRIVATE_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `*_KEY`, and the SSH agent socket.
 */
const CREDENTIAL_MORE = [
  /(^|_)TOKENS?$/i,
  /PASSW(OR)?D/i,
  /(^|_)CREDENTIALS?$/i,
  /(^|_)(PRIVATE_?)?KEY$/i,
  /^SSH_AUTH_SOCK$/i,
];
const KERNEL = /^(KPAI|KERNELPAI)_/i;

function credential(name: string): boolean {
  return CREDENTIAL.test(name) || CREDENTIAL_MORE.some((re) => re.test(name));
}

/**
 * The environment an agent CLI runs with: the parent's, minus every credential-shaped
 * variable, every variable KernelPAI's provider descriptors name (`auth.env`), the agent
 * descriptor's own `scrubEnv`, and KernelPAI's internal variables. The agent keeps PATH,
 * HOME and its own config, so it runs under the user's own login (its credentials live in
 * its own files, which KernelPAI never reads).
 */
export function agentEnv(
  parent: Env,
  scrub: readonly string[],
  extra: Readonly<Record<string, string>> = {},
  /** The agent's own login variables (descriptor `keepEnv`): never one of `scrub`. */
  keep: readonly string[] = [],
): Record<string, string> {
  const drop = new Set(scrub.map((s) => s.toUpperCase()));
  const own = new Set(keep.map((s) => s.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    const key = k.toUpperCase();
    if (drop.has(key) || KERNEL.test(k)) continue;
    if (credential(k) && !own.has(key)) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}

/** True when the variable would be removed from an agent's environment. */
export function isScrubbed(name: string, scrub: readonly string[]): boolean {
  return Object.keys(agentEnv({ [name]: 'x' }, scrub)).length === 0;
}
