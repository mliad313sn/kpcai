/**
 * `kpai pack list|show|detect|check|validate|init` (WI-S1-05, D-018). Domain packs are data:
 * this lists, explains, validates and scaffolds them. Tool suggestions are printed, marked
 * `[U]` when not verified against a primary source, and never installed.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { kpaiHome } from '@kernelpai/kernel';
import {
  PackIdSchema,
  checkPackFiles,
  checkPackText,
  describeZones,
  detectPacks,
  loadPacks,
  planZones,
  type LoadedPack,
  type Pack,
} from '@kernelpai/packs';
import type { Io } from '../io.js';
import { sanitizeForTerminal } from '../sanitize.js';

export const PACK_USAGE = `kpai pack list                 Packs available here (built-in, $KPAI_HOME/packs, .kpstudio/packs)
kpai pack show <id>            One pack: markers, plans, tools ([U] = unverified), zones, safety
kpai pack detect               Which packs this folder looks like, and why
kpai pack check <file.yaml>…   Validate pack files (alias: validate); exit 1 on any error
kpai pack init <id> [--out f]  Write a pack skeleton (default $KPAI_HOME/packs/<id>.yaml)
`;

const t = (s: string): string => sanitizeForTerminal(s);

async function loaded(io: Io): Promise<{ packs: LoadedPack[]; problems: string[] }> {
  const r = await loadPacks({ home: kpaiHome(io.env), repoRoot: io.cwd });
  return { packs: r.packs, problems: r.problems.map((p) => `${p.file}: ${p.problem}`) };
}

async function list(io: Io): Promise<number> {
  const { packs, problems } = await loaded(io);
  for (const l of packs) {
    const over = l.overrides.length ? `, overrides ${l.overrides.join('+')}` : '';
    io.out(`${l.pack.id.padEnd(24)} ${t(l.pack.name).padEnd(34)} (${l.layer}${over})\n`);
  }
  for (const p of problems) io.err(`✗ ${t(p)}\n`);
  return 0;
}

function describePack(p: Pack): string[] {
  const s = p.safety;
  const tools = p.tools.map(
    (x) => `  ${x.verified ? '   ' : '[U]'} ${t(x.name)} (${x.kind}): ${t(x.purpose)}`,
  );
  const safety = [
    s.requiresScope && `needs an authorised scope (${s.scopeKinds.join(', ')})`,
    s.preferLocal && 'prefers local models',
    s.personalData && 'personal data: keep local',
    s.physicalEffects && 'physical effects: confirm and simulate first',
  ].filter((x): x is string => typeof x === 'string');
  return [
    `${p.id} — ${t(p.name)} (v${p.version})`,
    t(p.description),
    `profiles: ${p.profiles.map(t).join(', ')}`,
    `markers: ${p.markers.map((m) => `${t(m.glob)}${m.optIn ? ' (opt-in)' : ''}`).join(' ') || 'none'}`,
    ...p.plans.map(
      (h) => `plan "${t(h.title)}": ${h.nodes.map((n) => `${n.id}/${n.deliverable}`).join(' → ')}`,
    ),
    ...(tools.length
      ? ['tools (suggestions, never installed; [U] = not verified):', ...tools]
      : []),
    ...describeZones(planZones([p], new Set())).map((z) => t(z)),
    ...safety.map((x) => `safety: ${x}`),
    ...s.limits.map((l) => `limit: ${t(l)}`),
    ...p.tips.map((x) => `tip: ${t(x)}`),
  ];
}

async function show(io: Io, id: string | undefined): Promise<number> {
  if (!id) return usage(io, 'pack show needs a pack id');
  const { packs } = await loaded(io);
  const l = packs.find((x) => x.pack.id === id);
  if (!l) {
    io.err(`no pack "${t(id)}" (see kpai pack list)\n`);
    return 1;
  }
  io.out(`${describePack(l.pack).join('\n')}\nfrom ${l.layer}: ${l.file}\n`);
  return 0;
}

async function detect(io: Io): Promise<number> {
  const { packs } = await loaded(io);
  const d = await detectPacks(
    io.cwd,
    packs.map((l) => l.pack),
  );
  for (const s of d.suggestions) {
    const ask = s.needsOptIn ? ' — needs your opt-in before it counts' : '';
    io.out(`${s.id.padEnd(24)} score ${s.score}  ${t(s.reason)}${ask}\n`);
  }
  if (d.truncated) io.out(`(stopped after ${d.scanned} entries)\n`);
  return 0;
}

async function check(io: Io, files: string[]): Promise<number> {
  if (files.length === 0) return usage(io, 'pack check needs at least one file');
  const reports = await checkPackFiles(files);
  for (const r of reports) (r.ok ? io.out : io.err)(`${r.lines.map(t).join('\n')}\n`);
  return reports.every((r) => r.ok) ? 0 : 1;
}

function skeleton(id: string): string {
  return [
    `id: ${id}`,
    'version: 1',
    `name: ${id.replace(/-/g, ' ')}`,
    'description: What this pack adapts KP Studio to (one or two sentences).',
    'profiles: [describe who uses it]',
    'markers:',
    "  - { glob: '*.example', why: Files that show a folder is this kind of workspace }",
    'plans: []',
    'tools: []',
    'zones: { add: [], relax: [] }',
    'safety: { requiresScope: false, preferLocal: false, physicalEffects: false, personalData: false }',
    'glossary: []',
    'tips: []',
    '',
  ].join('\n');
}

async function init(io: Io, id: string | undefined, out: string | undefined): Promise<number> {
  if (!id || !PackIdSchema.safeParse(id).success)
    return usage(io, 'pack init needs an id: lower-case letters, digits and single dashes');
  const file = out ?? join(kpaiHome(io.env), 'packs', `${id}.yaml`);
  if (existsSync(file)) {
    io.err(`${file} already exists; not overwritten\n`);
    return 1;
  }
  const text = skeleton(id);
  const r = checkPackText(text, file);
  if (!r.ok) throw new Error(`pack skeleton does not validate: ${r.lines.join('; ')}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, { flag: 'wx' });
  io.out(`wrote ${file}\nedit it, then: kpai pack check ${file}\n`);
  return 0;
}

function usage(io: Io, why: string): number {
  io.err(`${why}\n\n${PACK_USAGE}`);
  return 2;
}

export function packCommand(io: Io, rest: string[], o: { out?: string }): Promise<number> {
  const [sub, ...args] = rest;
  switch (sub) {
    case 'list':
      return list(io);
    case 'show':
      return show(io, args[0]);
    case 'detect':
      return detect(io);
    case 'check':
    case 'validate':
      return check(io, args);
    case 'init':
      return init(io, args[0], o.out);
    default:
      return Promise.resolve(usage(io, `unknown pack command "${sub ?? ''}"`));
  }
}
