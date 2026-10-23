import { globHits, relParts } from './paths.js';

/**
 * Forbidden zones in two tiers (spec §6, audit F2, WI-S7-01).
 *
 * **Credential zones** are immovable: no policy option, pack or approval relaxes them.
 * They name credential stores and key material, not words, so they rarely hit
 * legitimate work. Two narrow, built-in exemptions keep them precise:
 * `.env.example` / `.env.sample` / `.env.template` (placeholder files committed by
 * convention) and Apple Keynote documents named `*.key` (recognised by structure, not
 * by name: see keynote.ts; layers without file access keep `*.key` name-based).
 */
export const CREDENTIAL_ZONES: readonly string[] = [
  '.env',
  '.env.*',
  '.envrc',
  '*.pem',
  '*.key',
  '*.p8',
  '*.p12',
  '*.pfx',
  '*.ppk',
  '*.jks',
  '*.keystore',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '**/.ssh/**',
  '**/.aws/**',
  '**/.gnupg/**',
  '**/.azure/**',
  '**/.kube/**',
  '**/.config/gcloud/**',
  '**/.docker/config.json',
  'kubeconfig',
  '*.kubeconfig',
  '.npmrc',
  '.netrc',
  '_netrc',
  '.pypirc',
  '.pgpass',
  '.git-credentials',
  '.vault-token',
  'credentials.json',
  'client_secret*.json',
  'application_default_credentials.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
];

/**
 * **Name heuristics**: they catch real secrets but also detection rules, write-ups,
 * runbooks and policies (`aws_secret_access.yml`, `credentials_policy.md`). A user-enabled
 * pack may exempt named folders from these two globs only, after the user saw and
 * approved it (pack-zones.ts). Credential zones still apply inside those folders.
 */
export const HEURISTIC_ZONES: readonly string[] = ['**/credentials*', '**/*secret*'];

/** Every default zone, credential tier first (the historical flat list, extended). */
export const DEFAULT_ZONES: readonly string[] = [...CREDENTIAL_ZONES, ...HEURISTIC_ZONES];

/** Placeholder env files: by convention committed and free of real values. */
export const ENV_TEMPLATES: readonly string[] = ['.env.example', '.env.sample', '.env.template'];

export type ZoneTier = 'credential' | 'heuristic' | 'added';
/** Where a zone comes from: built in, `$KPAI_HOME/policy.json`, a pack, or the caller. */
export type ZoneOrigin = 'default' | 'policy.json' | 'caller' | `pack:${string}`;

export interface ZoneEntry {
  glob: string;
  tier: ZoneTier;
  origin: ZoneOrigin;
}

/** A pack relaxation in force: `allow` is exempt from the heuristic tier only. */
export interface ZoneRelaxation {
  pack: string;
  allow: string;
  reason: string;
}

/** The effective forbidden zones: one value shared by the policy, git and workspace layers. */
export interface ZoneSet {
  entries: readonly ZoneEntry[];
  relaxed: readonly ZoneRelaxation[];
  caseInsensitive: boolean;
}

/**
 * Answers whether the `*.key` item at a root-relative path is a Keynote document
 * (only layers with safe file access pass one; without it `*.key` stays forbidden).
 */
export type KeyProbe = (rel: string) => boolean;

export function defaultCaseInsensitive(): boolean {
  return process.platform === 'win32';
}

/** Tier of a glob found in a flat list (`forbiddenPaths`): the default tiers keep theirs. */
export function tierOf(glob: string): ZoneTier {
  if (CREDENTIAL_ZONES.includes(glob)) return 'credential';
  return HEURISTIC_ZONES.includes(glob) ? 'heuristic' : 'added';
}

/**
 * A zone set from a flat glob list (callers that only know `forbiddenPaths`). The
 * credential tier is always included, whatever the list says: it is immovable.
 */
export function zoneSetFromGlobs(
  globs: readonly string[],
  caseInsensitive = defaultCaseInsensitive(),
  origin: ZoneOrigin = 'caller',
): ZoneSet {
  const entries: ZoneEntry[] = CREDENTIAL_ZONES.map((glob) => ({
    glob,
    tier: 'credential',
    origin: 'default',
  }));
  for (const glob of globs) {
    const tier = tierOf(glob);
    if (tier === 'credential') continue;
    if (!entries.some((e) => e.glob === glob)) {
      entries.push({ glob, tier, origin: tier === 'heuristic' ? 'default' : origin });
    }
  }
  return { entries, relaxed: [], caseInsensitive };
}

/** The flat glob list of a zone set (for `describe()` and older callers). */
export function zoneGlobs(zones: ZoneSet): string[] {
  return [...new Set(zones.entries.map((e) => e.glob))];
}

function isTemplate(segment: string, ci: boolean): boolean {
  const s = ci ? segment.toLowerCase() : segment;
  return ENV_TEMPLATES.includes(s);
}

/** Hit indices of a credential glob, minus its built-in exemptions. */
function credentialHits(
  parts: string[],
  glob: string,
  ci: boolean,
  probe: KeyProbe | undefined,
): number[] {
  const hits = globHits(parts, glob, ci);
  if (glob === '.env.*') return hits.filter((i) => !isTemplate(parts[i] as string, ci));
  if (glob === '*.key' && probe) {
    return hits.filter((i) => !probe(parts.slice(0, i + 1).join('/')));
  }
  return hits;
}

/** First index at which an approved relaxation covers the path (Infinity when none). */
function relaxedFrom(parts: string[], zones: ZoneSet): number {
  let start = Number.POSITIVE_INFINITY;
  for (const r of zones.relaxed) {
    const hits = globHits(parts, r.allow, zones.caseInsensitive);
    if (hits.length > 0) start = Math.min(start, hits[0] as number);
  }
  return start;
}

/**
 * The entry that forbids a root-relative path, or undefined. Credential and added
 * zones always win. A heuristic hit yields only when an approved relaxation covers the
 * hit item or one of its parent folders, so a relaxation never opens a heuristic-named
 * folder above it (`my-secrets/detections/x` stays forbidden under `detections/**`).
 */
export function zoneHit(rel: string, zones: ZoneSet, probe?: KeyProbe): ZoneEntry | undefined {
  const parts = relParts(rel);
  if (parts.length === 0) return undefined;
  const ci = zones.caseInsensitive;
  let heuristic: { entry: ZoneEntry; first: number } | undefined;
  for (const entry of zones.entries) {
    if (entry.tier === 'credential') {
      if (credentialHits(parts, entry.glob, ci, probe).length > 0) return entry;
    } else if (entry.tier === 'added') {
      if (globHits(parts, entry.glob, ci).length > 0) return entry;
    } else {
      const hits = globHits(parts, entry.glob, ci);
      if (hits.length > 0 && (heuristic === undefined || (hits[0] as number) < heuristic.first)) {
        heuristic = { entry, first: hits[0] as number };
      }
    }
  }
  if (heuristic === undefined) return undefined;
  return heuristic.first < relaxedFrom(parts, zones) ? heuristic.entry : undefined;
}

/** True when a root-relative path is in a forbidden zone of the set. */
export function inForbiddenZone(rel: string, zones: ZoneSet, probe?: KeyProbe): boolean {
  return zoneHit(rel, zones, probe) !== undefined;
}

/** True when an approved relaxation is what lets this path through (for the journal). */
export function relaxationFor(rel: string, zones: ZoneSet): ZoneRelaxation | undefined {
  if (zones.relaxed.length === 0) return undefined;
  const parts = relParts(rel);
  const heuristicHit = zones.entries.some(
    (e) => e.tier === 'heuristic' && globHits(parts, e.glob, zones.caseInsensitive).length > 0,
  );
  if (!heuristicHit) return undefined;
  return zones.relaxed.find((r) => globHits(parts, r.allow, zones.caseInsensitive).length > 0);
}
