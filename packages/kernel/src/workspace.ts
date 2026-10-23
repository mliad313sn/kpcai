import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { acceptsWorkspace, loadPacks } from '@kernelpai/packs';
import { kpaiHome, type Env } from './env.js';
import { folderKey, optInsFile, readOptIns } from './packs.js';

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  '.kernelpai-workspace',
];

const NO_MARKER = `no project marker here (${PROJECT_MARKERS.join(', ')}, or the files of a domain pack: see \`kpai pack list\`); create .kernelpai-workspace to allow this folder`;

/** Home folder and filesystem roots: never a workspace, whatever they contain. */
function forbiddenFolder(dir: string, home: string): string | undefined {
  if (dir === resolve(home))
    return 'the working directory is your home folder; run kpai inside a project';
  if (dir === parse(dir).root)
    return 'the working directory is a filesystem root; run kpai inside a project';
  return undefined;
}

/**
 * Tools act inside the working directory, so it must be a project, not the home folder
 * or a drive root where `.ssh`, `.aws` and the like live (review P2-F10). Undefined when
 * fine. Built-in markers only; {@link workspaceVerdict} also accepts domain-pack folders.
 */
export function workspaceProblem(cwd: string, home: string = homedir()): string | undefined {
  const dir = resolve(cwd);
  const refused = forbiddenFolder(dir, home);
  if (refused) return refused;
  if (!PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))) return NO_MARKER;
  return undefined;
}

export interface WorkspaceVerdict {
  ok: boolean;
  problem?: string;
  /** The pack marker that made the folder a workspace (WI-S1-01). */
  by?: { pack: string; path: string; glob: string };
  /** Packs whose opt-in markers (a lone binary…) matched: ask the user first. */
  askOptIn: string[];
}

/**
 * WI-S1-01: the built-in markers, then the markers of the built-in and user packs (a
 * folder of CSVs, a QGIS or Godot project, a PlatformIO tree). Repository packs are not
 * consulted here: a folder cannot vouch for itself. Opt-in markers count only once the
 * user opted the folder in. Home and filesystem roots stay refused.
 */
export async function workspaceVerdict(
  cwd: string,
  env: Env,
  home: string = homedir(),
): Promise<WorkspaceVerdict> {
  const dir = resolve(cwd);
  const refused = forbiddenFolder(dir, home);
  if (refused) return { ok: false, problem: refused, askOptIn: [] };
  if (PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))) return { ok: true, askOptIn: [] };
  const { packs } = await loadPacks({ home: kpaiHome(env) });
  const optedIn = await readOptIns(env, await folderKey(dir));
  const r = await acceptsWorkspace(
    dir,
    packs.map((l) => l.pack),
    optedIn,
  ).catch(() => ({ accepted: false, askOptIn: [] as string[], by: undefined }));
  if (r.accepted) return { ok: true, ...(r.by ? { by: r.by } : {}), askOptIn: [] };
  if (r.askOptIn.length > 0) {
    const problem = `only files that need your opt-in were found here (packs: ${r.askOptIn.join(', ')}); opt this folder in, or create .kernelpai-workspace`;
    return { ok: false, problem, askOptIn: r.askOptIn };
  }
  return { ok: false, problem: NO_MARKER, askOptIn: [] };
}

/** Remembers that the user opted this folder into these packs. */
export async function saveOptIns(env: Env, cwd: string, packs: readonly string[]): Promise<void> {
  const file = optInsFile(env);
  let all: Record<string, string[]> = {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      all = parsed as Record<string, string[]>;
  } catch {
    // no file yet, or a broken one: start again
  }
  const key = await folderKey(cwd);
  const had = Array.isArray(all[key]) ? all[key] : [];
  all[key] = [...new Set([...had, ...packs])];
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
}
