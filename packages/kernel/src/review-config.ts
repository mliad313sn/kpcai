/**
 * The review policy (R-404, ADR-0029) from configuration (ADR-0030): environment variable
 * `KPAI_REVIEW_POLICY`, read by the kernel for the CLI and the console server alike.
 *
 * - unset, empty or `off`: no policy (each node keeps the protocol its plan gave it);
 * - `suggested`: R-404's suggestion (low → none, normal → critic, critical → critics);
 * - `low=none,normal=critic,critical=debate`: the suggestion with these depths instead
 *   (any subset of the three criticalities; depths none|critic|critics|debate|vote).
 *
 * Principle 2 still holds whatever the setting: code, tests and file deliverables keep at
 * least an author and a critic (the orchestrator's floor). A bad value is an error, never
 * a silent "off": the user asked for reviews.
 */
import type { Criticality } from '@kernelpai/core';
import {
  REVIEW_DEPTHS,
  SUGGESTED_REVIEW_POLICY,
  type ReviewDepth,
  type ReviewPolicy,
} from '@kernelpai/orchestrator';
import type { Env } from './env.js';

export const REVIEW_POLICY_ENV = 'KPAI_REVIEW_POLICY';
const CRITICALITIES: readonly Criticality[] = ['low', 'normal', 'critical'];

function bad(raw: string, why: string): Error {
  return new Error(
    `${REVIEW_POLICY_ENV} ${why}, got "${raw.slice(0, 200)}" (use off, suggested, or ` +
      `low=…,normal=…,critical=… with ${REVIEW_DEPTHS.join('|')})`,
  );
}

/** The review policy in force, or undefined when none is configured. Throws on a bad value. */
export function reviewPolicyOf(env: Env): ReviewPolicy | undefined {
  const raw = env[REVIEW_POLICY_ENV]?.trim() ?? '';
  if (raw === '' || raw === 'off') return undefined;
  if (raw === 'suggested') return SUGGESTED_REVIEW_POLICY;
  const out: Record<Criticality, ReviewDepth> = { ...SUGGESTED_REVIEW_POLICY };
  for (const part of raw.split(',').map((x) => x.trim())) {
    const [key, value, ...extra] = part.split('=').map((x) => x.trim());
    if (extra.length > 0 || !key || !value) throw bad(raw, 'has an item that is not key=depth');
    if (!CRITICALITIES.includes(key as Criticality))
      throw bad(raw, `names an unknown criticality "${key.slice(0, 40)}"`);
    if (!REVIEW_DEPTHS.includes(value as ReviewDepth))
      throw bad(raw, `names an unknown depth "${value.slice(0, 40)}"`);
    out[key as Criticality] = value as ReviewDepth;
  }
  return out;
}
