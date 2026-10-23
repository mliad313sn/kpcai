/**
 * Memory for front ends (ADR-0027): list, add, edit, remove facts per layer; the pending
 * proposals of models, confirmed or rejected by a human; export of the project memory into
 * the repository. Every change is journaled (ids, layer and source; the text is in the
 * memory file). Protocol `memory.*` and `kpai memory` are thin clients of this class.
 */
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Journal } from '@kernelpai/journal';
import {
  MemoryError,
  emptyDoc,
  serializeMemory,
  type Fact,
  type Layer,
  type LayerContent,
  type MemoryScope,
  type MemoryStore,
  type PendingFact,
} from '@kernelpai/memory';
import type { Confirm } from './confirm.js';
import type { Env } from './env.js';
import { KernelError } from './errors.js';
import { REPO_MEMORY_FILE, memoryStore } from './memory.js';
import { busPacks, folderKey, policyFor, selectPacks } from './packs.js';

export interface MemoryHost {
  env: Env;
  cwd: string;
  journal(): Journal;
  /** The session to journal an action in (this folder's). */
  session(action: string): string;
  confirm: Confirm;
  /** A checkpoint of the workspace before the export writes into it (R-305). */
  checkpoint(label: string, sessionId: string): Promise<string | undefined>;
}

/** A layer as front ends name it; `session` needs the session id. */
export interface LayerRef {
  layer: Layer;
  sessionId?: string;
}

/** Store errors in the kernel's terms (the CLI and the server map those). */
async function kernelErrors<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof MemoryError) throw new KernelError(err.code, err.message);
    throw err;
  }
}

function asked(p: PendingFact): string {
  const where = p.scope.layer === 'project' ? 'project' : p.scope.layer;
  const local = p.provenance.localOnly ? ', local-only' : '';
  const ev = p.provenance.evidence.length ? ` (${p.provenance.evidence.join(', ')})` : '';
  return `Remember this in ${where} memory${local}? Proposed by ${p.provenance.source}${ev}: "${p.text}". No keeps it pending.`;
}

export class KernelMemory {
  constructor(private readonly h: MemoryHost) {}

  /** The store with the zones in force here (packs' additions; relaxations not applied). */
  private async store(): Promise<MemoryStore> {
    const packs = await selectPacks(this.h.env, this.h.cwd).catch(() => undefined);
    const zoned = packs ? busPacks(packs, 'memory') : undefined;
    const { policy } = await policyFor(this.h.env, zoned, undefined, this.h.cwd);
    return memoryStore(this.h.env, policy.zoneSet());
  }

  async scope(ref: LayerRef): Promise<MemoryScope> {
    if (ref.layer === 'user') return { layer: 'user' };
    if (ref.layer === 'project') return { layer: 'project', repo: await folderKey(this.h.cwd) };
    if (!ref.sessionId) throw new KernelError('invalid', 'session memory needs a session id');
    return { layer: 'session', sessionId: ref.sessionId };
  }

  private journal(action: string, payload: Record<string, unknown>): void {
    const sessionId = this.h.session(action);
    this.h.journal().append({ sessionId, type: 'intervention', payload: { action, ...payload } });
  }

  async list(ref: LayerRef): Promise<LayerContent> {
    return kernelErrors((await this.store()).list(await this.scope(ref)));
  }

  async add(ref: LayerRef, text: string, localOnly = false): Promise<Fact> {
    const f = await kernelErrors(
      (await this.store()).add(await this.scope(ref), text, { localOnly }),
    );
    this.journal('memory add', { id: f.id, layer: f.layer, source: 'human' });
    return f;
  }

  async edit(
    ref: LayerRef,
    id: string,
    change: { text?: string; localOnly?: boolean },
  ): Promise<Fact> {
    const f = await kernelErrors((await this.store()).edit(await this.scope(ref), id, change));
    this.journal('memory edit', { id, layer: f.layer, source: f.provenance.source });
    return f;
  }

  async remove(ref: LayerRef, id: string): Promise<Fact> {
    const f = await kernelErrors((await this.store()).remove(await this.scope(ref), id));
    this.journal('memory remove', { id, layer: f.layer, source: f.provenance.source });
    return f;
  }

  async pending(): Promise<PendingFact[]> {
    return (await this.store()).pending();
  }

  async confirm(id: string): Promise<Fact> {
    const f = await kernelErrors((await this.store()).confirm(id));
    this.journal('memory confirmed', { id, layer: f.layer, source: f.provenance.source });
    return f;
  }

  async reject(id: string): Promise<PendingFact> {
    const p = await kernelErrors((await this.store()).reject(id));
    this.journal('memory rejected', { id, layer: p.scope.layer, source: p.provenance.source });
    return p;
  }

  /**
   * Asks the human about proposals, one `confirm.request` of kind `memory` each. Yes stores
   * the fact; anything else (no, silence, no human) leaves it pending: never auto-accepted.
   */
  async ask(
    ids: readonly string[],
    runId?: string,
  ): Promise<{ confirmed: Fact[]; pending: number }> {
    const confirmed: Fact[] = [];
    let pending = 0;
    for (const p of (await this.pending()).filter((x) => ids.includes(x.id))) {
      const req = { kind: 'memory' as const, question: asked(p), risk: 'write' as const };
      const yes = await this.h.confirm({
        ...req,
        ...(runId ? { runId } : {}),
        memory: memoryInfo(p),
      });
      if (!yes) {
        pending++;
        continue;
      }
      try {
        confirmed.push(await this.confirm(p.id));
      } catch {
        pending++; // refused by today's zones, or already handled elsewhere: stays as it is
      }
    }
    return { confirmed, pending };
  }

  /**
   * Writes the project memory into the repository as `.kpstudio/memory.md`, without its
   * local-only facts, after a checkpoint. It is read back as untrusted repository content.
   */
  async exportToRepo(): Promise<ExportResult> {
    const file = join(this.h.cwd, REPO_MEMORY_FILE);
    // Repository content is untrusted: a symlink here could point the write outside it.
    for (const p of [dirname(file), file]) {
      if ((await lstat(p).catch(() => undefined))?.isSymbolicLink())
        throw new KernelError('refused', `${REPO_MEMORY_FILE}: a symbolic link is never written`);
    }
    const content = await this.list({ layer: 'project' });
    const shared = content.facts.filter((f) => !f.provenance.localOnly);
    const doc = emptyDoc('project', { exported: 'from KernelPAI; read back as untrusted' });
    for (const f of shared) doc.lines.push({ kind: 'fact', fact: f });
    const sessionId = this.h.session('memory export');
    const checkpoint = await this.h.checkpoint('memory export', sessionId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, serializeMemory(doc));
    const withheld = content.facts.length - shared.length;
    this.journal('memory export', { path: REPO_MEMORY_FILE, facts: shared.length, withheld });
    return {
      path: REPO_MEMORY_FILE,
      facts: shared.length,
      withheld,
      ...(checkpoint ? { checkpoint } : {}),
    };
  }
}

export interface ExportResult {
  /** Repository-relative path written. */
  path: string;
  facts: number;
  /** Local-only facts kept out of the repository. */
  withheld: number;
  /** Workspace checkpoint taken before the write (git workspaces). */
  checkpoint?: string;
}

/** What a `memory` confirmation shows apart from the question. */
export function memoryInfo(p: PendingFact): MemoryConfirmInfo {
  return {
    id: p.id,
    layer: p.scope.layer,
    text: p.text,
    source: p.provenance.source,
    evidence: [...p.provenance.evidence],
    localOnly: p.provenance.localOnly,
  };
}

export interface MemoryConfirmInfo {
  id: string;
  layer: Layer;
  text: string;
  source: string;
  evidence: string[];
  localOnly: boolean;
}
