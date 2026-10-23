/**
 * The memory store (ADR-0027): facts in Markdown per layer, model proposals in a pending
 * queue. A human adds, edits and removes facts; a model can only `propose`, and a proposal
 * is stored only when a human `confirm`s it. Every text is screened (guard.ts) first.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  appendFact,
  emptyDoc,
  factsOf,
  parseMemory,
  serializeMemory,
  type MemoryDoc,
} from './format.js';
import { KeyedLock, memoryFile, pendingFile, readText, writeAtomic } from './files.js';
import { screenFact, type Guard } from './guard.js';
import {
  MemoryError,
  type Fact,
  type MemoryProblem,
  type MemoryScope,
  type PendingFact,
  type Provenance,
} from './types.js';

export const MAX_PENDING = 200;

export interface MemoryStoreOptions extends Guard {
  /** `$KPAI_HOME`. */
  home: string;
  now?: () => Date;
  maxPending?: number;
}

export interface LayerContent {
  scope: MemoryScope;
  file: string;
  exists: boolean;
  facts: Fact[];
  problems: MemoryProblem[];
}

export interface ProposalInput {
  scope: MemoryScope;
  text: string;
  localOnly?: boolean;
}

const ScopeSchema = z.discriminatedUnion('layer', [
  z.object({ layer: z.literal('user') }),
  z.object({ layer: z.literal('project'), repo: z.string().min(1) }),
  z.object({ layer: z.literal('session'), sessionId: z.string().min(1) }),
]);
const PendingSchema = z.object({
  id: z.string().regex(/^m-[a-z0-9]{4,32}$/i),
  scope: ScopeSchema,
  text: z.string().min(1),
  provenance: z.object({
    source: z.string().min(1),
    date: z.string(),
    evidence: z.array(z.string()),
    localOnly: z.boolean(),
  }),
  proposedAt: z.string(),
});

export class MemoryStore {
  private readonly lock = new KeyedLock();
  private readonly now: () => Date;

  constructor(private readonly o: MemoryStoreOptions) {
    this.now = o.now ?? (() => new Date());
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private async load(
    scope: MemoryScope,
  ): Promise<{ doc: MemoryDoc; file: string; exists: boolean }> {
    const file = memoryFile(this.o.home, scope);
    const text = await readText(file);
    const meta: Record<string, string> = scope.layer === 'project' ? { repo: scope.repo } : {};
    const doc = text === undefined ? emptyDoc(scope.layer, meta) : parseMemory(text, scope.layer);
    return { doc, file, exists: text !== undefined };
  }

  /** The facts of one layer, with what looked odd in the file (nothing is dropped). */
  async list(scope: MemoryScope): Promise<LayerContent> {
    const { doc, file, exists } = await this.load(scope);
    return { scope, file, exists, facts: factsOf(doc), problems: doc.problems };
  }

  /** Read-modify-write of one file under its lock. */
  private change<T>(scope: MemoryScope, fn: (doc: MemoryDoc) => T): Promise<T> {
    const file = memoryFile(this.o.home, scope);
    return this.lock.run(file, async () => {
      const { doc } = await this.load(scope);
      const out = fn(doc);
      await writeAtomic(file, serializeMemory(doc));
      return out;
    });
  }

  private newId(taken: ReadonlySet<string>): string {
    for (;;) {
      const id = `m-${randomBytes(4).toString('hex')}`;
      if (!taken.has(id)) return id;
    }
  }

  /** A fact the human writes (`source: human`). */
  async add(
    scope: MemoryScope,
    text: string,
    opts: { localOnly?: boolean; evidence?: string[] } = {},
  ): Promise<Fact> {
    const clean = screenFact(text, this.o);
    const provenance: Provenance = {
      source: 'human',
      date: this.today(),
      evidence: [...(opts.evidence ?? [])],
      localOnly: opts.localOnly === true,
    };
    return this.change(scope, (doc) => {
      const id = this.newId(new Set(factsOf(doc).map((f) => f.id)));
      const fact: Fact = { id, layer: scope.layer, text: clean, provenance };
      appendFact(doc, fact);
      return fact;
    });
  }

  /** Changes a fact's text or its local-only flag; its source and date stay. */
  async edit(
    scope: MemoryScope,
    id: string,
    change: { text?: string; localOnly?: boolean },
  ): Promise<Fact> {
    const clean = change.text === undefined ? undefined : screenFact(change.text, this.o);
    return this.change(scope, (doc) => {
      const line = doc.lines.find((l) => l.kind === 'fact' && l.fact.id === id);
      if (!line || line.kind !== 'fact') throw new MemoryError('not_found', `no fact ${id}`);
      const f = line.fact;
      const provenance = { ...f.provenance, edited: this.today() };
      if (change.localOnly !== undefined) provenance.localOnly = change.localOnly;
      line.fact = { ...f, text: clean ?? f.text, provenance };
      return line.fact;
    });
  }

  async remove(scope: MemoryScope, id: string): Promise<Fact> {
    return this.change(scope, (doc) => {
      const at = doc.lines.findIndex((l) => l.kind === 'fact' && l.fact.id === id);
      const line = doc.lines[at];
      if (!line || line.kind !== 'fact') throw new MemoryError('not_found', `no fact ${id}`);
      doc.lines.splice(at, 1);
      return line.fact;
    });
  }

  private async readPending(): Promise<PendingFact[]> {
    const text = await readText(pendingFile(this.o.home));
    if (text === undefined) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return [];
    }
    const list = Array.isArray(raw) ? raw : [];
    return list.flatMap((x) => {
      const r = PendingSchema.safeParse(x);
      return r.success ? [r.data as PendingFact] : [];
    });
  }

  private changePending<T>(fn: (list: PendingFact[]) => T | Promise<T>): Promise<T> {
    const file = pendingFile(this.o.home);
    return this.lock.run(file, async () => {
      const list = await this.readPending();
      const out = await fn(list);
      await writeAtomic(file, `${JSON.stringify(list, null, 2)}\n`);
      return out;
    });
  }

  /** Proposals waiting for a human, oldest first. */
  pending(): Promise<PendingFact[]> {
    return this.readPending();
  }

  /**
   * A model's proposal: screened, then queued. It is never stored before `confirm`.
   * Refused when the source is `human` (humans `add`), already known, or the queue is full.
   */
  async propose(
    input: ProposalInput,
    from: { source: string; evidence?: string[] },
  ): Promise<PendingFact> {
    if (!from.source || from.source === 'human')
      throw new MemoryError('invalid', 'a proposal comes from a model; a human adds facts');
    const text = screenFact(input.text, this.o);
    const known = await this.list(input.scope);
    if (known.facts.some((f) => f.text === text))
      throw new MemoryError('refused', 'this fact is already in memory');
    return this.changePending((list) => {
      const same = list.find((p) => p.text === text && sameScope(p.scope, input.scope));
      if (same) return same;
      if (list.length >= (this.o.maxPending ?? MAX_PENDING))
        throw new MemoryError('refused', 'the pending queue is full; confirm or reject first');
      const ids = new Set([...list.map((p) => p.id), ...known.facts.map((f) => f.id)]);
      const provenance: Provenance = {
        source: from.source,
        date: this.today(),
        evidence: [...(from.evidence ?? [])],
        localOnly: input.localOnly === true,
      };
      const p: PendingFact = {
        id: this.newId(ids),
        scope: input.scope,
        text,
        provenance,
        proposedAt: this.now().toISOString(),
      };
      list.push(p);
      return p;
    });
  }

  /** A human said yes: the proposal becomes a fact, its model source kept, `confirmed` set. */
  async confirm(id: string): Promise<Fact> {
    const p = await this.takePending(id);
    try {
      const text = screenFact(p.text, this.o);
      const provenance: Provenance = { ...p.provenance, confirmed: this.today() };
      return await this.change(p.scope, (doc) => {
        const fact: Fact = { id: p.id, layer: p.scope.layer, text, provenance };
        if (factsOf(doc).some((f) => f.id === p.id)) fact.id = this.newId(new Set());
        appendFact(doc, fact);
        return fact;
      });
    } catch (err) {
      // Not stored (refused by today's zones, disk error): it stays pending.
      await this.changePending((list) => void list.unshift(p));
      throw err;
    }
  }

  /** A human said no: the proposal is dropped. */
  reject(id: string): Promise<PendingFact> {
    return this.takePending(id);
  }

  private takePending(id: string): Promise<PendingFact> {
    return this.changePending((list) => {
      const at = list.findIndex((p) => p.id === id);
      if (at < 0) throw new MemoryError('not_found', `no pending proposal ${id}`);
      return list.splice(at, 1)[0] as PendingFact;
    });
  }
}

export function sameScope(a: MemoryScope, b: MemoryScope): boolean {
  if (a.layer !== b.layer) return false;
  if (a.layer === 'project') return a.repo === (b as typeof a).repo;
  if (a.layer === 'session') return a.sessionId === (b as typeof a).sessionId;
  return true;
}
