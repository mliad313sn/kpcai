/**
 * `kpai memory` (ADR-0027): the user's and the project's memory, with provenance. The
 * human lists, adds, edits and removes facts, and confirms or rejects what models proposed.
 * `export` writes the project memory into the repository as `.kpstudio/memory.md`, which
 * is then read back as untrusted repository content.
 */
import { Kernel, type LayerRef } from '@kernelpai/kernel';
import type { Fact, PendingFact } from '@kernelpai/memory';
import { kernelHost } from '../host.js';
import type { Io } from '../io.js';
import { sanitizeForTerminal } from '../sanitize.js';

export const MEMORY_USAGE = `kpai memory list [--layer user|project]        Facts with their provenance
kpai memory add <text> [--layer …] [--local-only]  Add a fact you write (default: project)
kpai memory edit <id> <text> [--layer …]       Change a fact's text
kpai memory rm <id> [--layer …]                Remove a fact
kpai memory pending                            Facts models proposed, waiting for you
kpai memory confirm <id> | reject <id>         Keep or drop a proposal
kpai memory export                             Write project memory to .kpstudio/memory.md
  (--layer session --session <id> for a session's memory)
`;

export interface MemoryCliOptions {
  db?: string | undefined;
  layer?: string | undefined;
  session?: string | undefined;
  localOnly?: boolean | undefined;
}

const t = (s: string): string => sanitizeForTerminal(s);

class MemoryUsage extends Error {}

function layerOf(o: MemoryCliOptions, fallback: LayerRef['layer']): LayerRef {
  const layer = o.layer ?? fallback;
  if (layer !== 'user' && layer !== 'project' && layer !== 'session')
    throw new MemoryUsage('--layer must be user, project or session');
  if (layer === 'session' && !o.session)
    throw new MemoryUsage('--layer session needs --session <id>');
  return layer === 'session' ? { layer, sessionId: o.session } : { layer };
}

function factLine(f: Fact): string {
  const p = f.provenance;
  const who = p.source === 'human' ? 'you' : `${p.source} (untrusted)`;
  const tags = [who, p.date || 'undated', ...p.evidence, p.localOnly ? 'local-only' : '']
    .filter(Boolean)
    .map(t);
  return `${f.id}  ${t(f.text)}\n            ${tags.join(' · ')}\n`;
}

function pendingLine(p: PendingFact): string {
  const v = p.provenance;
  const tags = [p.scope.layer, `proposed by ${v.source}`, v.date, ...v.evidence];
  if (v.localOnly) tags.push('local-only');
  return `${p.id}  ${t(p.text)}\n            ${tags.map(t).join(' · ')}\n`;
}

async function list(io: Io, k: Kernel, o: MemoryCliOptions): Promise<number> {
  const refs = o.layer ? [layerOf(o, 'project')] : [layerOf(o, 'user'), layerOf(o, 'project')];
  for (const ref of refs) {
    const l = await k.memory.list(ref);
    io.out(`# ${ref.layer} memory (${l.facts.length}) — ${t(l.file)}\n`);
    for (const f of l.facts) io.out(factLine(f));
    for (const p of l.problems) io.err(`  ! line ${p.line}: ${t(p.message)}\n`);
  }
  const pending = (await k.memory.pending()).length;
  if (pending) io.out(`${pending} proposal(s) pending: kpai memory pending\n`);
  return 0;
}

/** The layer holding a fact id: the one given, else user then project. */
async function holder(k: Kernel, o: MemoryCliOptions, id: string): Promise<LayerRef> {
  if (o.layer) return layerOf(o, 'project');
  for (const ref of [layerOf(o, 'user'), layerOf(o, 'project')]) {
    if ((await k.memory.list(ref)).facts.some((f) => f.id === id)) return ref;
  }
  return layerOf(o, 'project');
}

type Sub = (io: Io, k: Kernel, args: string[], o: MemoryCliOptions) => Promise<number>;

function need(args: string[], n: number, what: string): void {
  if (args.length < n || args.slice(0, n).some((a) => !a)) throw new MemoryUsage(what);
}

const SUBS: Readonly<Record<string, Sub>> = {
  list: (io, k, _a, o) => list(io, k, o),
  add: async (io, k, args, o) => {
    need(args, 1, 'memory add needs the text of the fact');
    const f = await k.memory.add(layerOf(o, 'project'), args.join(' '), o.localOnly === true);
    io.out(`added ${f.id} to ${f.layer} memory: ${t(f.text)}\n`);
    return 0;
  },
  edit: async (io, k, args, o) => {
    need(args, 2, 'memory edit needs an id and the new text');
    const [id, ...text] = args as [string, ...string[]];
    const f = await k.memory.edit(await holder(k, o, id), id, { text: text.join(' ') });
    io.out(`edited ${f.id}: ${t(f.text)}\n`);
    return 0;
  },
  rm: async (io, k, args, o) => {
    need(args, 1, 'memory rm needs a fact id');
    const f = await k.memory.remove(await holder(k, o, args[0]!), args[0]!);
    io.out(`removed ${f.id} from ${f.layer} memory\n`);
    return 0;
  },
  pending: async (io, k) => {
    const all = await k.memory.pending();
    if (all.length === 0) io.out('no proposal pending\n');
    for (const p of all) io.out(pendingLine(p));
    return 0;
  },
  confirm: async (io, k, args) => {
    need(args, 1, 'memory confirm needs a proposal id');
    const f = await k.memory.confirm(args[0]!);
    io.out(`kept ${f.id} in ${f.layer} memory (source ${t(f.provenance.source)})\n`);
    return 0;
  },
  reject: async (io, k, args) => {
    need(args, 1, 'memory reject needs a proposal id');
    const p = await k.memory.reject(args[0]!);
    io.out(`rejected ${p.id}\n`);
    return 0;
  },
  export: async (io, k) => {
    const r = await k.exportMemory();
    const kept = r.withheld ? ` (${r.withheld} local-only fact(s) kept out)` : '';
    const undo = r.checkpoint ? `\nundo: kpai restore ${r.checkpoint}` : '';
    io.out(`wrote ${r.facts} fact(s) to ${r.path}${kept}; read back as untrusted${undo}\n`);
    return 0;
  },
};

export async function memoryCommand(io: Io, rest: string[], o: MemoryCliOptions): Promise<number> {
  const [sub = 'list', ...args] = rest;
  const run = Object.hasOwn(SUBS, sub) ? SUBS[sub] : undefined;
  if (!run) {
    io.err(`unknown memory command "${t(sub)}"\n\n${MEMORY_USAGE}`);
    return 2;
  }
  const kernel = new Kernel(kernelHost(io, o.db ? { db: o.db } : {}));
  try {
    return await run(io, kernel, args, o);
  } catch (err) {
    if (!(err instanceof MemoryUsage)) throw err;
    io.err(`${err.message}\n\n${MEMORY_USAGE}`);
    return 2;
  } finally {
    await kernel.close();
  }
}
