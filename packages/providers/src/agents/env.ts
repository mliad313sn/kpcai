import type { Env } from '../env.js';

/**
 * Names that look like a credential: removed from an agent's environment whatever their
 * origin, so KernelPAI's own keys (or any other API key the parent holds) never reach a
 * child process that runs untrusted model output as code.
 */
const CREDENTIAL = /(_API_KEY|_API_TOKEN|_AUTH_TOKEN|_ACCESS_KEY|_SECRET|_SECRET_KEY)$/i;
const KERNEL = /^(KPAI|KERNELPAI)_/i;

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
): Record<string, string> {
  const drop = new Set(scrub.map((s) => s.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (drop.has(k.toUpperCase()) || CREDENTIAL.test(k) || KERNEL.test(k)) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}

/** True when the variable would be removed from an agent's environment. */
export function isScrubbed(name: string, scrub: readonly string[]): boolean {
  return Object.keys(agentEnv({ [name]: 'x' }, scrub)).length === 0;
}
