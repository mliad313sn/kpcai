import { matchesForbidden } from './paths.js';
import {
  CREDENTIAL_ZONES,
  HEURISTIC_ZONES,
  type ZoneEntry,
  type ZoneOrigin,
  type ZoneRelaxation,
  type ZoneSet,
} from './zones.js';

/** Zone requests of the user's enabled packs, as resolved by pack-zones.ts. */
export interface PackZonePlan {
  /** Globs added by packs: always in force, never relaxable. */
  added: { pack: string; glob: string }[];
  /** Relaxations in force: enabled pack, shown and approved, valid, journaled. */
  relaxed: ZoneRelaxation[];
  /** Relaxations waiting for the user's approval: shown, never applied. */
  pending: ZoneRelaxation[];
  /** Relaxations refused outright, with a reason the user can read. */
  refused: { pack: string; allow: string; problem: string }[];
}

export const EMPTY_PACK_ZONES: PackZonePlan = { added: [], relaxed: [], pending: [], refused: [] };

/**
 * Paths a relaxation must never match: one sample per credential zone. A pack that
 * names any of them is refused with a clear error, even though the credential tier
 * would still win (the user should not be told a credential store was opened).
 */
export const CREDENTIAL_SAMPLES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.production',
  '.envrc',
  'server.pem',
  'private.key',
  'AuthKey_ABC123.p8',
  'cert.p12',
  'cert.pfx',
  'putty.ppk',
  'release.jks',
  'debug.keystore',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_ed25519.pub',
  '.ssh/config',
  '.ssh/id_rsa',
  '.aws/credentials',
  '.aws/config',
  '.gnupg/pubring.kbx',
  '.azure/accessTokens.json',
  '.kube/config',
  '.config/gcloud/application_default_credentials.json',
  '.docker/config.json',
  'kubeconfig',
  'prod.kubeconfig',
  '.npmrc',
  '.netrc',
  '_netrc',
  '.pypirc',
  '.pgpass',
  '.git-credentials',
  '.vault-token',
  'credentials',
  'credentials.json',
  'client_secret.json',
  'application_default_credentials.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'config/secrets.yml',
];

function longestLiteral(glob: string): number {
  return Math.max(0, ...glob.split(/[*?/[\]]+/).map((s) => s.length));
}

/** Files that hold nothing: a folder relaxation covers them, a credential-targeting one does not. */
const NEUTRAL = ['kp-neutral-note.txt', 'kp-neutral-dir/kp-neutral-note.txt'];

/**
 * The credential sample a relaxation glob would open, if any: at the root, or inside
 * its own folder when the glob targets credential names rather than the whole folder
 * (`deploy/*.pem`, `certs/id_rsa`). A folder relaxation (`detections/**`) passes: the
 * credential tier still wins inside it.
 */
function credentialTarget(g: string, first: string): string | undefined {
  const root = CREDENTIAL_SAMPLES.find((p) => matchesForbidden(p, [g], true));
  if (root !== undefined || /[*?[\]]/.test(first)) return root;
  if (NEUTRAL.some((n) => matchesForbidden(`${first}/${n}`, [g], true))) return undefined;
  return CREDENTIAL_SAMPLES.find((p) => matchesForbidden(`${first}/${p}`, [g], true));
}

/**
 * Why a relaxation glob is refused, or undefined. A relaxation must not match any
 * credential store, must be anchored at a literal folder or file of the workspace
 * root (`detections/**`, `writeups/ctf.md`) and must not be near-universal.
 */
export function relaxationProblem(allow: string): string | undefined {
  const g = allow.replace(/\\/g, '/');
  if (g.includes('\0') || g.startsWith('/') || g.split('/').includes('..')) {
    return `"${allow}" is not a workspace-relative glob`;
  }
  const first = g.split('/')[0] ?? '';
  const hit = credentialTarget(g, first);
  if (hit !== undefined) {
    return `"${allow}" would expose credential files such as ${hit}; credential zones cannot be relaxed`;
  }
  if (!g.includes('/') || first === '' || first === '.' || /[*?[\]]/.test(first)) {
    return `"${allow}" must start with a folder name of the workspace (such as detections/**)`;
  }
  if (longestLiteral(g) < 3) return `"${allow}" is too broad (name a folder or file pattern)`;
  return undefined;
}

export interface ZoneSetInput {
  /** Include the relaxable name heuristics. */
  heuristics: boolean;
  policyPaths: readonly string[];
  callerPaths: readonly string[];
  packs?: PackZonePlan;
  caseInsensitive: boolean;
}

/**
 * The effective zones: credential tier (always), heuristics (unless switched off),
 * policy.json, caller and pack additions (never relaxable, even when they repeat a
 * heuristic), and the approved pack relaxations, re-checked here.
 */
export function buildZoneSet(input: ZoneSetInput): ZoneSet {
  const entries: ZoneEntry[] = CREDENTIAL_ZONES.map((glob) => ({
    glob,
    tier: 'credential',
    origin: 'default',
  }));
  const add = (glob: string, tier: ZoneEntry['tier'], origin: ZoneOrigin): void => {
    if (CREDENTIAL_ZONES.includes(glob)) return;
    if (!entries.some((e) => e.glob === glob && e.origin === origin)) {
      entries.push({ glob, tier, origin });
    }
  };
  if (input.heuristics) for (const g of HEURISTIC_ZONES) add(g, 'heuristic', 'default');
  for (const g of input.policyPaths) add(g, 'added', 'policy.json');
  for (const g of input.callerPaths) add(g, 'added', 'caller');
  for (const a of input.packs?.added ?? []) add(a.glob, 'added', `pack:${a.pack}`);
  const relaxed = (input.packs?.relaxed ?? []).map((r) => {
    const problem = relaxationProblem(r.allow);
    if (problem !== undefined) throw new Error(`zone relaxation by ${r.pack} refused: ${problem}`);
    return { pack: r.pack, allow: r.allow, reason: r.reason };
  });
  return { entries, relaxed, caseInsensitive: input.caseInsensitive };
}
