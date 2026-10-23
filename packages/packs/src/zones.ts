import { literalLength, matchesAny } from './glob.js';
import type { Pack } from './schema.js';

/**
 * Credential stores. No pack, layer or approval can relax these (principle 5, R-605).
 * Mirrors the credential half of DEFAULT_FORBIDDEN_PATHS in packages/tools/src/policy.ts.
 */
export const CORE_CREDENTIAL_ZONES: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa*',
  'id_ed25519*',
  '**/.aws/**',
  '**/.ssh/**',
  '**/.gnupg/**',
  '.npmrc',
  '.netrc',
];

/**
 * Name heuristics from the same default list. They catch real secrets but also
 * detection rules, runbooks and policies (`aws_secret_access.yml`, `credentials_policy.md`),
 * so a pack may exempt named folders from them, with the user's approval.
 */
export const HEURISTIC_ZONES: readonly string[] = ['**/credentials*', '**/*secret*'];

/** Paths a relaxation must never open, wherever they sit. */
export const CREDENTIAL_SAMPLES: readonly string[] = [
  '.env',
  '.env.local',
  'id_rsa',
  'id_ed25519.pub',
  '.ssh/config',
  '.aws/credentials',
  '.gnupg/pubring.kbx',
  'server.pem',
  'private.key',
  '.npmrc',
  '.netrc',
  'credentials',
  'credentials.json',
  'client_secret.json',
  'secrets.yaml',
  'secrets.yml',
  'config/secrets.yml',
];

/** Why a relaxation glob is refused, or undefined when it is narrow enough. */
export function relaxProblem(allow: string): string | undefined {
  if (literalLength(allow) < 3) return `"${allow}" is too broad (name a folder or file pattern)`;
  const hit = CREDENTIAL_SAMPLES.find((p) => matchesAny(p, [allow]));
  if (hit !== undefined) return `"${allow}" would expose credential files such as ${hit}`;
  return undefined;
}

export interface ZonePlan {
  /** Globs added by packs (always in force). */
  added: string[];
  /** Relaxations in force (approved and valid), with the pack that asked. */
  relaxed: { pack: string; allow: string; reason: string }[];
  /** Relaxations waiting for the user's approval: show them, never apply them silently. */
  pending: { pack: string; allow: string; reason: string }[];
  /** Relaxations refused outright, with the reason. */
  refused: { pack: string; allow: string; problem: string }[];
}

/** Approval key for one relaxation, as stored by the caller (`pack:glob`). */
export function relaxKey(pack: string, allow: string): string {
  return `${pack}:${allow}`;
}

/** Combines the zone requests of active packs. `approved` holds {@link relaxKey}s. */
export function planZones(packs: readonly Pack[], approved: ReadonlySet<string>): ZonePlan {
  const plan: ZonePlan = { added: [], relaxed: [], pending: [], refused: [] };
  for (const p of packs) {
    for (const g of p.zones.add) if (!plan.added.includes(g)) plan.added.push(g);
    for (const r of p.zones.relax) {
      const problem = relaxProblem(r.allow);
      const item = { pack: p.id, allow: r.allow, reason: r.reason };
      if (problem !== undefined) plan.refused.push({ pack: p.id, allow: r.allow, problem });
      else if (approved.has(relaxKey(p.id, r.allow))) plan.relaxed.push(item);
      else plan.pending.push(item);
    }
  }
  return plan;
}

/**
 * Reference decision for a root-relative path: credential zones and pack additions
 * always win; heuristic zones yield only to approved relaxations.
 */
export function isForbidden(rel: string, plan: ZonePlan, caseInsensitive = false): boolean {
  if (matchesAny(rel, CORE_CREDENTIAL_ZONES, caseInsensitive)) return true;
  if (matchesAny(rel, plan.added, caseInsensitive)) return true;
  if (!matchesAny(rel, HEURISTIC_ZONES, caseInsensitive)) return false;
  const allows = plan.relaxed.map((r) => r.allow);
  return !matchesAny(rel, allows, caseInsensitive);
}

/** Lines for the plan view: what changed in the forbidden zones and why. */
export function describeZones(plan: ZonePlan): string[] {
  const out: string[] = [];
  for (const g of plan.added) out.push(`zone added: ${g}`);
  for (const r of plan.relaxed) out.push(`zone relaxed by ${r.pack}: ${r.allow} (${r.reason})`);
  for (const r of plan.pending)
    out.push(`needs your approval (${r.pack}): ${r.allow} — ${r.reason}`);
  for (const r of plan.refused) out.push(`refused (${r.pack}): ${r.problem}`);
  return out;
}
