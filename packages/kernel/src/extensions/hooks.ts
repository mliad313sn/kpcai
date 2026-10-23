/**
 * Lifecycle hooks (R-502, ADR-0033): `before-plan`, `before-tool` and `after-patch`, from
 * `$KPAI_HOME/hooks.json` (the user's) and `.kpstudio/hooks.json` (the repository's,
 * untrusted). A hook is a program run through the tool bus (`shell.run`), so the bus's
 * jail, zones, scrubbed environment, timeout and journal apply, and it is a confirmed
 * process unless `$KPAI_HOME/hooks.json` allow-lists its exact command line. An `allow`
 * list in a repository file is ignored: a repository cannot allow-list itself.
 */
import type { ZoneSet } from '@kernelpai/tools';
import { z } from 'zod';
import { NAME, readPlaceFile, type Origin, type Place } from './read.js';

export const HOOK_EVENTS = ['before-plan', 'before-tool', 'after-patch'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const HOOK_DEFAULT_TIMEOUT_MS = 10_000;
export const HOOK_MAX_TIMEOUT_MS = 60_000;
const HOOKS_MAX_BYTES = 64 * 1024;

const CommandLine = {
  command: z.string().min(1).max(256),
  args: z.array(z.string().max(1000)).max(64).default([]),
};

const HookSchema = z.strictObject({
  name: z.string().regex(NAME),
  event: z.enum(HOOK_EVENTS),
  ...CommandLine,
  /** `before-tool`: tool names, or prefixes ending in `*` (`fs.*`); absent: every tool. */
  tools: z.array(z.string().min(1).max(100)).max(50).optional(),
  timeoutMs: z.number().int().min(100).max(HOOK_MAX_TIMEOUT_MS).default(HOOK_DEFAULT_TIMEOUT_MS),
});

const HooksFileSchema = z.strictObject({
  hooks: z.array(HookSchema).max(50).default([]),
  /** Command lines that run without a confirmation (read from `$KPAI_HOME` only). */
  allow: z.array(z.strictObject(CommandLine)).max(100).optional(),
});

export interface HookSpec extends z.infer<typeof HookSchema> {
  origin: Origin;
  /** True when `$KPAI_HOME/hooks.json` allow-lists this exact command line. */
  allowListed: boolean;
}

export interface LoadedHooks {
  hooks: HookSpec[];
  /** Hooks files that exist but do not parse: veto hooks fail closed while they are broken. */
  broken: string[];
  problems: string[];
}

export const NO_HOOKS: LoadedHooks = { hooks: [], broken: [], problems: [] };

type HooksFile = z.infer<typeof HooksFileSchema>;

async function readHooksFile(
  place: Place,
  zones: ZoneSet,
): Promise<{ path: string; file?: HooksFile; error?: string } | undefined> {
  const found = await readPlaceFile(place, 'hooks.json', HOOKS_MAX_BYTES, zones);
  if (!found) return undefined;
  if (found.truncated) return { path: found.path, error: 'too large' };
  try {
    const r = HooksFileSchema.safeParse(JSON.parse(found.text));
    if (r.success) return { path: found.path, file: r.data };
    const first = r.error.issues[0];
    return { path: found.path, error: `${first?.path.join('.')}: ${first?.message}` };
  } catch (err) {
    return { path: found.path, error: err instanceof Error ? err.message : String(err) };
  }
}

const lineKey = (c: { command: string; args: readonly string[] }): string =>
  JSON.stringify([c.command, ...c.args]);

/** The hooks of the user's home and of the repository; the home's allow-list applies to both. */
export async function loadHooks(home: string, root: string, zones: ZoneSet): Promise<LoadedHooks> {
  const places: Place[] = [
    { origin: 'home', base: home, dir: '' },
    { origin: 'repo', base: root, dir: '.kpstudio' },
  ];
  const out: LoadedHooks = { hooks: [], broken: [], problems: [] };
  const allowed = new Set<string>();
  const seen = new Set<string>();
  for (const place of places) {
    const r = await readHooksFile(place, zones);
    if (!r) continue;
    if (!r.file) {
      out.broken.push(r.path);
      out.problems.push(`${r.path}: ${r.error ?? 'invalid'}`);
      continue;
    }
    if (place.origin === 'home') for (const a of r.file.allow ?? []) allowed.add(lineKey(a));
    else if (r.file.allow?.length)
      out.problems.push(`${r.path}: "allow" is ignored in a repository (set it in $KPAI_HOME)`);
    for (const h of r.file.hooks) {
      const key = `${h.event}:${h.name}`;
      if (seen.has(key)) {
        out.problems.push(`${r.path}: hook ${h.name} already defined for ${h.event}`);
        continue;
      }
      seen.add(key);
      out.hooks.push({ ...h, origin: place.origin, allowListed: false });
    }
  }
  for (const h of out.hooks) h.allowListed = allowed.has(lineKey(h));
  return out;
}

/** Whether a `before-tool` hook applies to this tool name. */
export function hookMatches(h: Pick<HookSpec, 'tools'>, tool: string): boolean {
  if (!h.tools) return true;
  return h.tools.some((p) => (p.endsWith('*') ? tool.startsWith(p.slice(0, -1)) : p === tool));
}

/** What a plan shows about hooks: names, events, origins and command lines. */
export function hooksSummary(l: LoadedHooks): Array<{
  name: string;
  event: HookEvent;
  origin: Origin;
  command: string;
  allowListed: boolean;
}> {
  return l.hooks.map((h) => ({
    name: h.name,
    event: h.event,
    origin: h.origin,
    command: [h.command, ...h.args].join(' ').slice(0, 300),
    allowListed: h.allowListed,
  }));
}
