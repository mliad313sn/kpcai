/**
 * Skills in the Claude Code SKILL.md format (R-502, ADR-0033): `<dir>/<name>/SKILL.md` with
 * front matter (`name`, `description`, `allowed-tools`, …) and a Markdown procedure. Found
 * in the repository (`.kpstudio/skills`, `.claude/skills`: untrusted) and in
 * `$KPAI_HOME/skills` (the user's). A skill is text a node reads; it never grants a tool,
 * a zone or a budget: `allowed-tools` can only narrow the node's own tools.
 */
import type { ZoneSet } from '@kernelpai/tools';
import {
  NAME,
  frontMatter,
  listField,
  listPlace,
  readPlaceFile,
  textField,
  type Origin,
  type Place,
} from './read.js';

export const SKILL_MAX_BYTES = 32 * 1024;
const MAX_DESCRIPTION = 1024;

export interface Skill {
  name: string;
  description: string;
  origin: Origin;
  path: string;
  /** KernelPAI tool names the skill allows; absent: the node's tools are kept as they are. */
  allowedTools?: string[];
  /** The procedure, untrusted when `origin` is `repo`. Never shown to the planner. */
  body: string;
  truncated: boolean;
}

/** Claude Code tool names and the KernelPAI tools they correspond to. */
const CLAUDE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  read: ['fs.read'],
  ls: ['fs.list'],
  glob: ['fs.list'],
  grep: ['fs.read'],
  write: ['fs.write'],
  edit: ['fs.write'],
  multiedit: ['fs.write'],
  bash: ['shell.run'],
};

/**
 * `allowed-tools` as KernelPAI tool names: dotted names are kept, Claude Code names are
 * mapped (`Read` → `fs.read`, `Bash(git:*)` → `shell.run`), unknown ones dropped. A
 * mapping can only make the list shorter than the node's: it is intersected, never added.
 */
export function mapAllowedTools(list: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    const name = raw.replace(/\(.*\)$/, '').trim();
    if (/^[a-z][a-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/.test(name)) out.add(name);
    for (const t of CLAUDE_TOOLS[name.toLowerCase()] ?? []) out.add(t);
  }
  return [...out];
}

export const SKILL_PLACES = (root: string, home: string): Place[] => [
  // The user's own skills first: a repository cannot shadow one of them.
  { origin: 'home', base: home, dir: 'skills' },
  { origin: 'repo', base: root, dir: '.kpstudio/skills' },
  { origin: 'repo', base: root, dir: '.claude/skills' },
];

/** Parses one SKILL.md; returns a problem line instead when it is not a valid skill. */
export function parseSkill(
  file: { origin: Origin; path: string; text: string; truncated: boolean },
  folder: string,
): Skill | string {
  let fm;
  try {
    fm = frontMatter(file.text);
  } catch (err) {
    return `${file.path}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const name = textField(fm.data.name, 80) ?? folder;
  if (!NAME.test(name)) return `${file.path}: invalid skill name`;
  const description = textField(fm.data.description, MAX_DESCRIPTION);
  if (!description) return `${file.path}: a skill needs a description`;
  const listed = listField(fm.data['allowed-tools'] ?? fm.data.allowedTools);
  return {
    name,
    description,
    origin: file.origin,
    path: file.path,
    ...(listed ? { allowedTools: mapAllowedTools(listed) } : {}),
    body: fm.body.trim(),
    truncated: file.truncated,
  };
}

/** Every skill of the places, first one of a name wins; problems are safe to show. */
export async function discoverSkills(
  places: readonly Place[],
  zones: ZoneSet,
): Promise<{ skills: Skill[]; problems: string[] }> {
  const skills: Skill[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const place of places) {
    for (const folder of await listPlace(place, zones)) {
      const file = await readPlaceFile(place, `${folder}/SKILL.md`, SKILL_MAX_BYTES, zones);
      if (!file) continue;
      const s = parseSkill(file, folder);
      if (typeof s === 'string') problems.push(s);
      else if (seen.has(s.name)) problems.push(`${s.path}: skill ${s.name} already defined`);
      else {
        seen.add(s.name);
        skills.push(s);
      }
    }
  }
  return { skills, problems };
}
