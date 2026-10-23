/**
 * Domain packs at the kernel boundary (D-018, D-019, D-020): which packs apply to the
 * workspace and why, the forbidden zones in force with their tier and origin, and the
 * user's decisions on pack zone relaxations. Zones themselves are S7's (`@kernelpai/tools`:
 * one ZoneSet, credential tier immovable); the kernel passes the packs to every tool bus
 * and stores relaxation approvals as `relaxKey`s after a confirmation round-trip.
 */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { detectPacks, loadPacks, type Pack, type PackSuggestion } from '@kernelpai/packs';
import {
  buildPolicy,
  describePackZones,
  loadPolicyConfig,
  planPackZones,
  relaxKey,
  type GradedPermissionPolicy,
  type PackZoneOptions,
  type PackZonePlan,
  type ToolJournal,
  type ZoneEntry,
} from '@kernelpai/tools';
import { journalPackZones } from '@kernelpai/tools';
import { kpaiHome, type Env } from './env.js';

export interface PackChoice {
  id: string;
  name: string;
  /** Why it was chosen (files found, or the fallback). */
  reason: string;
  evidence: string[];
  requiresScope: boolean;
  scopeKinds: string[];
  preferLocal: boolean;
  physicalEffects: boolean;
  personalData: boolean;
  limits: string[];
}

type Relaxation = PackZonePlan['pending'][number];

export interface PackContext {
  packs: PackChoice[];
  /** Every forbidden zone in force for this plan: glob, tier and origin (S7's ZoneEntry). */
  zones: ZoneEntry[];
  /** Pack relaxations in force (approved by the user, heuristic tier only). */
  relaxed: Relaxation[];
  /** Pack relaxations waiting for the user's approval: shown, asked at run start. */
  pending: Relaxation[];
  /** Pack relaxations refused outright (credential tier, too broad…), with the reason. */
  refused: PackZonePlan['refused'];
  /** `describePackZones` lines for a plan view. */
  lines: string[];
  /** Pack files that could not be loaded (safe to show). */
  problems: string[];
}

/** The packs behind a context and the user's approvals, kept by the kernel. */
export interface SelectedPacks extends PackContext {
  selected: Pack[];
  approved: string[];
}

/** The key per-folder decisions are stored under: the folder's real path. */
export async function folderKey(cwd: string): Promise<string> {
  return realpath(cwd).catch(() => resolve(cwd));
}

/** Opt-ins live in `$KPAI_HOME/workspace-optins.json`: `{ "<folder>": ["pack-id"] }`. */
export function optInsFile(env: Env): string {
  return join(kpaiHome(env), 'workspace-optins.json');
}

/** Zone decisions in `$KPAI_HOME/zone-approvals.json`: `{ "<folder>": {approved, declined} }`. */
export function approvalsFile(env: Env): string {
  return join(kpaiHome(env), 'zone-approvals.json');
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export async function readOptIns(env: Env, key: string): Promise<Set<string>> {
  return new Set(strings((await readJson(optInsFile(env)))[key]));
}

export async function readZoneDecisions(
  env: Env,
  key: string,
): Promise<{ approved: string[]; declined: string[] }> {
  const entry = (await readJson(approvalsFile(env)))[key] as Record<string, unknown> | undefined;
  return { approved: strings(entry?.['approved']), declined: strings(entry?.['declined']) };
}

/** Records the user's answer on pack zone relaxations (`relaxKey`s) for this folder. */
export async function saveZoneDecisions(
  env: Env,
  cwd: string,
  answers: ReadonlyArray<{ key: string; approved: boolean }>,
): Promise<void> {
  const file = approvalsFile(env);
  const all = await readJson(file);
  const key = await folderKey(cwd);
  const had = await readZoneDecisions(env, key);
  const approved = new Set(had.approved);
  const declined = new Set(had.declined);
  for (const a of answers) {
    (a.approved ? approved : declined).add(a.key);
    (a.approved ? declined : approved).delete(a.key);
  }
  all[key] = { approved: [...approved], declined: [...declined] };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
}

function choice(s: PackSuggestion, pack: Pack): PackChoice {
  const f = pack.safety;
  return {
    id: pack.id,
    name: pack.name,
    reason: s.reason,
    evidence: s.evidence.map((e) => e.path),
    requiresScope: f.requiresScope,
    scopeKinds: [...f.scopeKinds],
    preferLocal: f.preferLocal,
    physicalEffects: f.physicalEffects,
    personalData: f.personalData,
    limits: [...f.limits],
  };
}

/**
 * The graded policy in force: defaults, `policy.json`, and the packs' zones. Relaxations
 * apply only when approved and journaled (S7: fail closed without a journal).
 */
export async function policyFor(
  env: Env,
  packs?: PackZoneOptions,
  journal?: ToolJournal,
): Promise<{ policy: GradedPermissionPolicy; packZones: PackZonePlan }> {
  const config = (await loadPolicyConfig(kpaiHome(env))).config;
  const planned = packs ? planPackZones(packs) : undefined;
  const packZones = planned
    ? journal
      ? journalPackZones(planned, journal, packs?.sessionId)
      : { ...planned, relaxed: [] }
    : { added: [], relaxed: [], pending: [], refused: [] };
  return { policy: buildPolicy(config, { packZones }), packZones };
}

/**
 * Packs for the workspace: built-in, `$KPAI_HOME/packs` and the repository's
 * `.kpstudio/packs` (which can only tighten safety, see the packs loader). Every matching
 * pack applies: a cap could drop one that requires a scope or adds zones. Opt-in markers
 * count only for packs the user opted this folder into.
 */
export async function selectPacks(env: Env, dir: string): Promise<SelectedPacks> {
  const loaded = await loadPacks({ home: kpaiHome(env), repoRoot: dir });
  const byId = new Map(loaded.packs.map((l) => [l.pack.id, l.pack]));
  const key = await folderKey(dir);
  const optedIn = await readOptIns(env, key);
  const det = await detectPacks(dir, [...byId.values()]);
  const picked = det.suggestions
    .filter((s) => (!s.needsOptIn || optedIn.has(s.id)) && byId.has(s.id))
    .map((s) => ({ s, pack: byId.get(s.id) as Pack }));
  const selected = picked.map((p) => p.pack);
  const { approved } = await readZoneDecisions(env, key);
  // Plan view: relaxations count as in force only once approved (not journaled yet here).
  const plan = planPackZones({ enabled: selected, approved });
  const config = (await loadPolicyConfig(kpaiHome(env))).config;
  const zones = buildPolicy(config, { packZones: plan }).describe().zones;
  return {
    selected,
    approved,
    packs: picked.map(({ s, pack }) => choice(s, pack)),
    zones,
    relaxed: plan.relaxed,
    pending: plan.pending,
    refused: plan.refused,
    lines: describePackZones(plan),
    problems: loaded.problems.map((p) => `${p.file}: ${p.problem}`.slice(0, 500)),
  };
}

/** No pack could be read: the policy's zones alone. */
export async function noPacks(env: Env, problem: string): Promise<SelectedPacks> {
  const { policy } = await policyFor(env);
  return {
    selected: [],
    approved: [],
    packs: [],
    zones: policy.describe().zones,
    relaxed: [],
    pending: [],
    refused: [],
    lines: [],
    problems: [problem.slice(0, 500)],
  };
}

/** What a tool bus is given for a run's packs (S7's `packs` option). */
export function busPacks(p: SelectedPacks, sessionId: string): PackZoneOptions {
  return { enabled: p.selected, approved: p.approved, sessionId };
}

/** What the protocol and the journal show: no full pack objects. */
export function packSummary(ctx: PackContext): PackContext {
  return {
    packs: ctx.packs,
    zones: ctx.zones,
    relaxed: ctx.relaxed,
    pending: ctx.pending,
    refused: ctx.refused,
    lines: ctx.lines,
    problems: ctx.problems,
  };
}

export { relaxKey };
