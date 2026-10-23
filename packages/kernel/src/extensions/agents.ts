/**
 * Named agents in the Claude Code format (R-502, ADR-0033): `<dir>/<name>.md` with front
 * matter (`name`, `description`, `tools`, `model`) and instructions. A node assigned an
 * agent gets the instructions as untrusted text and the agent's tools as a subset of its
 * own (narrowing only). `model` is a hint resolved through the YAML catalog, never a
 * model id written in code.
 */
import type { ZoneSet } from '@kernelpai/tools';
import { mapAllowedTools } from './skills.js';
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

export const AGENT_MAX_BYTES = 32 * 1024;

export interface NamedAgent {
  name: string;
  description: string;
  origin: Origin;
  path: string;
  /** KernelPAI tool names; absent: the node's tools are kept as they are. */
  tools?: string[];
  /** A model hint (`sonnet`, `provider/model`…), resolved against the catalog. */
  model?: string;
  /** The agent's instructions, untrusted when `origin` is `repo`. */
  body: string;
  truncated: boolean;
}

export const AGENT_PLACES = (root: string, home: string): Place[] => [
  { origin: 'home', base: home, dir: 'agents' },
  { origin: 'repo', base: root, dir: '.kpstudio/agents' },
  { origin: 'repo', base: root, dir: '.claude/agents' },
];

export function parseAgent(
  file: { origin: Origin; path: string; text: string; truncated: boolean },
  stem: string,
): NamedAgent | string {
  let fm;
  try {
    fm = frontMatter(file.text);
  } catch (err) {
    return `${file.path}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const name = textField(fm.data.name, 80) ?? stem;
  if (!NAME.test(name)) return `${file.path}: invalid agent name`;
  const description = textField(fm.data.description, 1024);
  if (!description) return `${file.path}: an agent needs a description`;
  const tools = listField(fm.data.tools);
  const model = textField(fm.data.model, 100);
  return {
    name,
    description,
    origin: file.origin,
    path: file.path,
    ...(tools ? { tools: mapAllowedTools(tools) } : {}),
    ...(model ? { model } : {}),
    body: fm.body.trim(),
    truncated: file.truncated,
  };
}

export async function discoverAgents(
  places: readonly Place[],
  zones: ZoneSet,
): Promise<{ agents: NamedAgent[]; problems: string[] }> {
  const agents: NamedAgent[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const place of places) {
    for (const entry of await listPlace(place, zones)) {
      if (!entry.endsWith('.md')) continue;
      const file = await readPlaceFile(place, entry, AGENT_MAX_BYTES, zones);
      if (!file) continue;
      const a = parseAgent(file, entry.slice(0, -3));
      if (typeof a === 'string') problems.push(a);
      else if (seen.has(a.name)) problems.push(`${a.path}: agent ${a.name} already defined`);
      else {
        seen.add(a.name);
        agents.push(a);
      }
    }
  }
  return { agents, problems };
}
