import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { matchesGlob } from './glob.js';
import type { Pack } from './schema.js';

/** Folders never walked: version control, dependency caches, virtual environments. */
export const SKIP_DIRS: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  '.gradle',
  '.pio',
  'Library',
  'Temp',
  '.godot',
];

export interface DetectOptions {
  /** Folder depth walked below the root (root entries are depth 1). Default 3. */
  maxDepth?: number;
  /** Entries examined before stopping. Default 5000. */
  maxEntries?: number;
  caseInsensitive?: boolean;
}

export interface PackSuggestion {
  id: string;
  name: string;
  score: number;
  /** Up to five root-relative paths that matched, with the marker glob. */
  evidence: { path: string; glob: string; optIn: boolean }[];
  /** Only opt-in markers matched (for example a lone binary): ask before using. */
  needsOptIn: boolean;
  reason: string;
}

export interface Detection {
  suggestions: PackSuggestion[];
  /** Entries seen; `truncated` when a bound stopped the walk. */
  scanned: number;
  truncated: boolean;
}

interface Entry {
  rel: string;
  dir: boolean;
}

/**
 * Lists entries under `root` breadth-first. Never follows a symlink (links are not
 * listed, so nothing outside the root is reached), skips {@link SKIP_DIRS}, bounded.
 */
export async function walk(
  root: string,
  opts: DetectOptions = {},
): Promise<{ entries: Entry[]; scanned: number; truncated: boolean }> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxEntries = opts.maxEntries ?? 5000;
  const realRoot = await realpath(root);
  const entries: Entry[] = [];
  let queue: string[] = [''];
  let truncated = false;
  for (let depth = 1; depth <= maxDepth && queue.length > 0 && !truncated; depth++) {
    const next: string[] = [];
    for (const relDir of queue) {
      const names = await readdir(path.join(realRoot, relDir)).catch(() => [] as string[]);
      for (const name of names.sort()) {
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        const rel = relDir === '' ? name : `${relDir}/${name}`;
        const st = await lstat(path.join(realRoot, rel)).catch(() => undefined);
        if (st === undefined || st.isSymbolicLink()) continue;
        entries.push({ rel, dir: st.isDirectory() });
        if (st.isDirectory() && !SKIP_DIRS.includes(name)) next.push(rel);
      }
      if (truncated) break;
    }
    queue = next;
  }
  return { entries, scanned: entries.length, truncated };
}

function score(pack: Pack, entries: Entry[], icase: boolean): PackSuggestion | undefined {
  const evidence: PackSuggestion['evidence'] = [];
  let points = 0;
  for (const m of pack.markers) {
    const hit = entries.find((e) => matchesGlob(e.rel, m.glob, icase));
    if (hit === undefined) continue;
    points += m.weak ? 0.25 : m.optIn ? 0.5 : 1;
    if (evidence.length < 5) evidence.push({ path: hit.rel, glob: m.glob, optIn: m.optIn });
  }
  if (points === 0) return undefined;
  const needsOptIn = evidence.every((e) => e.optIn);
  const shown = evidence.map((e) => e.path).join(', ');
  return {
    id: pack.id,
    name: pack.name,
    score: points,
    evidence,
    needsOptIn,
    reason: needsOptIn ? `only opt-in files found (${shown}); ask first` : `found ${shown}`,
  };
}

/** The id of the pack used when nothing matches. */
export const GENERIC_PACK_ID = 'general';

/**
 * Suggests packs from the file names present under `root` (no file is opened).
 * Falls back to the generic pack, when loaded, if nothing matches.
 */
export async function detectPacks(
  root: string,
  packs: readonly Pack[],
  opts: DetectOptions = {},
): Promise<Detection> {
  const { entries, scanned, truncated } = await walk(root, opts);
  const icase = opts.caseInsensitive ?? process.platform !== 'linux';
  const suggestions = packs
    .map((p) => score(p, entries, icase))
    .filter((s): s is PackSuggestion => s !== undefined)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const generic = packs.find((p) => p.id === GENERIC_PACK_ID);
  if (suggestions.length === 0 && generic !== undefined) {
    suggestions.push({
      id: generic.id,
      name: generic.name,
      score: 0,
      evidence: [],
      needsOptIn: false,
      reason: 'no domain pack matched these files',
    });
  }
  return { suggestions, scanned, truncated };
}

export interface WorkspaceAcceptance {
  accepted: boolean;
  /** The pack and file that made the folder acceptable. */
  by?: { pack: string; path: string; glob: string };
  /** Packs whose opt-in markers matched but were not opted in. */
  askOptIn: string[];
}

/**
 * Proposed extension of the workspace guard (WI-S1-01): a folder is a workspace if a
 * pack marker matches within two levels; opt-in markers count only for `optedIn` packs.
 * Home and filesystem roots stay refused by the guard itself, before this is asked.
 */
export async function acceptsWorkspace(
  root: string,
  packs: readonly Pack[],
  optedIn: ReadonlySet<string> = new Set(),
  opts: DetectOptions = {},
): Promise<WorkspaceAcceptance> {
  const det = await detectPacks(root, packs, { maxDepth: 2, maxEntries: 2000, ...opts });
  const askOptIn: string[] = [];
  for (const s of det.suggestions) {
    const usable = s.evidence.find((e) => !e.optIn || optedIn.has(s.id));
    if (usable)
      return { accepted: true, by: { pack: s.id, path: usable.path, glob: usable.glob }, askOptIn };
    if (s.evidence.length > 0) askOptIn.push(s.id);
  }
  return { accepted: false, askOptIn };
}
