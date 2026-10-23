import { readFile } from 'node:fs/promises';
import { parsePack } from './load.js';
import type { Pack } from './schema.js';
import { describeZones, planZones } from './zones.js';

export interface CheckReport {
  file: string;
  ok: boolean;
  /** Human-readable lines: errors when not ok, a summary when ok. */
  lines: string[];
  pack?: Pack;
}

const HINTS: [RegExp, string][] = [
  [/Unrecognized key/i, 'hint: a field name is misspelt or not supported; see PACK-AUTHORING.md'],
  [/model id/i, 'hint: name capabilities or task types, never a model; the router picks models'],
  [/price|token limit/i, 'hint: prices and limits live in provider descriptors, not packs'],
  [
    /expected one of "analysis"/i,
    'hint: use an existing task type; list new ones under proposedTaskTypes',
  ],
  [/too broad|credential files/i, 'hint: relax a named folder, e.g. "detections/**"'],
];

function hints(error: string): string[] {
  return HINTS.filter(([re]) => re.test(error)).map(([, h]) => h);
}

function summary(pack: Pack): string[] {
  const zones = describeZones(planZones([pack], new Set()));
  const scope = pack.safety.requiresScope
    ? [`needs an authorised scope (${pack.safety.scopeKinds.join(', ')}) before running`]
    : [];
  return [
    `ok: ${pack.id} — ${pack.name}`,
    `  ${pack.markers.length} marker(s), ${pack.plans.length} plan hint(s), ${pack.tools.length} tool suggestion(s)`,
    ...scope.map((s) => `  ${s}`),
    ...zones.map((z) => `  ${z}`),
  ];
}

/** Validates one pack's YAML text with messages a pack author can act on. */
export function checkPackText(text: string, file = '<text>'): CheckReport {
  const parsed = parsePack(text);
  if ('error' in parsed) {
    const errs = parsed.error.split(/;\s|\n/).filter((l) => l.trim() !== '');
    return {
      file,
      ok: false,
      lines: [`error in ${file}:`, ...errs.map((e) => `  ${e}`), ...hints(parsed.error)],
    };
  }
  return { file, ok: true, lines: summary(parsed.pack), pack: parsed.pack };
}

/** Validates pack files; never throws (unreadable files are reported). */
export async function checkPackFiles(files: readonly string[]): Promise<CheckReport[]> {
  const out: CheckReport[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      out.push({ file, ok: false, lines: [`error in ${file}: ${(err as Error).message}`] });
      continue;
    }
    out.push(checkPackText(text, file));
  }
  return out;
}
