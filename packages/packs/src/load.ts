import { lstat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { PackSchema, type Pack } from './schema.js';
import { packProblems } from './validate.js';

/** Where a pack came from, in merge order: later layers override earlier ones. */
export type PackLayer = 'builtin' | 'user' | 'repo';

export interface LoadedPack {
  pack: Pack;
  layer: PackLayer;
  file: string;
  /** Layers this id was also defined in, overridden by this one. */
  overrides: PackLayer[];
}

export interface LoadResult {
  packs: LoadedPack[];
  /** Files skipped or refused, with the reason; safe to show. */
  problems: { file: string; problem: string }[];
}

export const MAX_PACK_BYTES = 64 * 1024;
export const MAX_PACK_FILES = 200;

/** The packs shipped with this package (`packages/packs/packs`). */
export const BUILTIN_PACK_DIR = fileURLToPath(new URL('../packs/', import.meta.url));

export type ParsedPack = { pack: Pack } | { error: string };

/** YAML text → validated pack. Never throws. */
export function parsePack(text: string): ParsedPack {
  let raw: unknown;
  try {
    raw = parseYaml(text, { maxAliasCount: 50 });
  } catch (err) {
    return { error: `not valid YAML: ${(err as Error).message.split('\n')[0]}` };
  }
  const res = PackSchema.safeParse(raw);
  if (!res.success) return { error: z.prettifyError(res.error) };
  const problems = packProblems(res.data);
  return problems.length > 0 ? { error: problems.join('; ') } : { pack: res.data };
}

interface DirRead {
  files: { file: string; text: string }[];
  problems: LoadResult['problems'];
}

async function readRegular(file: string): Promise<string> {
  const st = await lstat(file);
  if (st.isSymbolicLink()) throw new Error('symlinks are not followed');
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size > MAX_PACK_BYTES) throw new Error(`larger than ${MAX_PACK_BYTES} bytes`);
  return readFile(file, 'utf8');
}

/** Reads `*.yaml` / `*.yml` directly in `dir`; no recursion, no symlinks, bounded. */
export async function readPackDir(dir: string): Promise<DirRead> {
  const out: DirRead = { files: [], problems: [] };
  const st = await lstat(dir).catch(() => undefined);
  if (st === undefined) return out;
  if (st.isSymbolicLink() || !st.isDirectory()) {
    out.problems.push({ file: dir, problem: 'pack folder must be a real folder, not a link' });
    return out;
  }
  const names = (await readdir(dir)).filter((n) => /\.ya?ml$/i.test(n)).sort();
  if (names.length > MAX_PACK_FILES) {
    out.problems.push({
      file: dir,
      problem: `more than ${MAX_PACK_FILES} pack files; extra ignored`,
    });
  }
  for (const name of names.slice(0, MAX_PACK_FILES)) {
    const file = path.join(dir, name);
    try {
      out.files.push({ file, text: await readRegular(file) });
    } catch (err) {
      out.problems.push({ file, problem: (err as Error).message });
    }
  }
  return out;
}

export interface LoadOptions {
  /** Default {@link BUILTIN_PACK_DIR}. */
  builtinDir?: string;
  /** `$KPAI_HOME`; default env KPAI_HOME, else ~/.kernelpai. Packs in `<home>/packs`. */
  home?: string;
  /** Workspace root; packs in `<root>/.kpstudio/packs` (repository content, untrusted). */
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export function packDirs(opts: LoadOptions = {}): { layer: PackLayer; dir: string }[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env['KPAI_HOME']?.trim() || path.join(homedir(), '.kernelpai'));
  const dirs: { layer: PackLayer; dir: string }[] = [
    { layer: 'builtin', dir: opts.builtinDir ?? BUILTIN_PACK_DIR },
    { layer: 'user', dir: path.join(home, 'packs') },
  ];
  if (opts.repoRoot !== undefined) {
    dirs.push({ layer: 'repo', dir: path.join(opts.repoRoot, '.kpstudio', 'packs') });
  }
  return dirs;
}

/**
 * Safety only tightens across layers: a user pack of a built-in id replaces the pack, but
 * keeps `requiresScope`, `preferLocal`, `physicalEffects`, `personalData`, scope kinds,
 * limits and zone additions of the built-in one. Repository packs never get here: they
 * cannot reuse an id at all ({@link admitRepoPack}).
 */
export function mergeOverride(base: Pack, next: Pack): Pack {
  const union = <T>(a: T[], b: T[]): T[] => [...new Set([...a, ...b])];
  return {
    ...next,
    zones: { add: union(base.zones.add, next.zones.add), relax: next.zones.relax },
    safety: {
      requiresScope: base.safety.requiresScope || next.safety.requiresScope,
      preferLocal: base.safety.preferLocal || next.safety.preferLocal,
      physicalEffects: base.safety.physicalEffects || next.safety.physicalEffects,
      personalData: base.safety.personalData || next.safety.personalData,
      scopeKinds: union(base.safety.scopeKinds, next.safety.scopeKinds),
      limits: union(base.safety.limits, next.safety.limits),
    },
  };
}

const LAYER_NAME: Record<PackLayer, string> = {
  builtin: 'built-in pack',
  user: 'user pack ($KPAI_HOME/packs)',
  repo: 'repository pack',
};

/**
 * A repository pack is repository content (untrusted, ADR-0025 addendum, P3-F4): it may
 * not reuse the id of a built-in or user pack, and its `zones.relax` is dropped, so it can
 * add zones and tighten safety but never take over a trusted pack's plans, name or
 * relaxations. Returns the pack to keep, or the problem that refuses it.
 */
export function admitRepoPack(
  pack: Pack,
  prev: LoadedPack | undefined,
): { pack: Pack; problem?: string } | { refused: string } {
  if (prev) {
    return {
      refused: `repository pack ${pack.id} reuses the id of a ${LAYER_NAME[prev.layer]}: ignored (a repository file cannot redefine a trusted pack; give it its own id)`,
    };
  }
  if (pack.zones.relax.length === 0) return { pack };
  return {
    pack: { ...pack, zones: { add: pack.zones.add, relax: [] } },
    problem: `zones.relax ignored for ${pack.id}: repository packs can only add zones (put relaxations in a $KPAI_HOME pack)`,
  };
}

/**
 * Loads built-in → `$KPAI_HOME/packs` → `<repo>/.kpstudio/packs`. A user pack overrides a
 * built-in one of the same id (see {@link mergeOverride}); a repository pack never
 * overrides anything (see {@link admitRepoPack}).
 */
export async function loadPacks(opts: LoadOptions = {}): Promise<LoadResult> {
  const byId = new Map<string, LoadedPack>();
  const problems: LoadResult['problems'] = [];
  for (const { layer, dir } of packDirs(opts)) {
    const read = await readPackDir(dir);
    problems.push(...read.problems);
    for (const { file, text } of read.files) {
      const parsed = parsePack(text);
      if ('error' in parsed) {
        problems.push({ file, problem: parsed.error });
        continue;
      }
      const prev = byId.get(parsed.pack.id);
      if (prev?.layer === layer) {
        problems.push({ file, problem: `duplicate pack id ${parsed.pack.id} in ${layer} packs` });
        continue;
      }
      if (layer === 'repo') {
        const admitted = admitRepoPack(parsed.pack, prev);
        if ('refused' in admitted) {
          problems.push({ file, problem: admitted.refused });
          continue;
        }
        if (admitted.problem) problems.push({ file, problem: admitted.problem });
        byId.set(admitted.pack.id, { pack: admitted.pack, layer, file, overrides: [] });
        continue;
      }
      const pack = prev ? mergeOverride(prev.pack, parsed.pack) : parsed.pack;
      const overrides = prev ? [...prev.overrides, prev.layer] : [];
      byId.set(pack.id, { pack, layer, file, overrides });
    }
  }
  const packs = [...byId.values()].sort((a, b) => a.pack.id.localeCompare(b.pack.id));
  return { packs, problems };
}
