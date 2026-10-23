/**
 * `$KPAI_HOME` as a forbidden zone when it lies inside the workspace (ADR-0030, ADR-0027
 * "revisit"). It holds memory, policy.json (which defines the zones themselves), approvals,
 * packs, the journal and the server token: a model's tools, a patch or a merge must never
 * read or write any of it. Only the kernel's own APIs, driven by a human, change them.
 * Added by the kernel to every policy it builds for that workspace (an `added` zone of
 * origin `caller`), so `@kernelpai/tools` needs no notion of the home folder.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { isInside } from '@kernelpai/tools';
import { kpaiHome, type Env } from './env.js';

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The kernel's own files when `$KPAI_HOME` is the workspace root itself (pathological). */
const HOME_FILES = [
  'memory/**',
  'packs/**',
  'projects/**',
  'worktrees/**',
  'policy.json',
  'mcp.json',
  'server.json',
  'zone-approvals.json',
  'workspace-optins.json',
  'journal.db*',
];

/** The globs of `home` relative to `root`, when `home` is inside `root`. */
function globsOf(root: string, home: string): string[] {
  if (!isInside(root, home)) return [];
  const rel = path.relative(root, home).split(path.sep).join('/');
  return rel ? [`${rel}/**`] : HOME_FILES;
}

/**
 * Zones the kernel adds for `root`: none when `$KPAI_HOME` is outside it. Both the
 * lexical and the resolved paths are checked (a symlinked temp folder, a home given
 * through a link), and every glob found is kept.
 */
export function homeZones(env: Env, root: string | undefined): string[] {
  if (root === undefined) return [];
  const home = kpaiHome(env);
  const globs = [
    ...globsOf(path.resolve(root), path.resolve(home)),
    ...globsOf(real(root), real(home)),
  ];
  return [...new Set(globs)];
}
