/** Read-only questions a front end asks the kernel: providers, tools, journal, stats. */
import { metrics, type ExecutorMetrics } from '@kernelpai/executor';
import {
  sessionToMarkdown,
  type Journal,
  type JournalEvent,
  type SessionRow,
} from '@kernelpai/journal';
import { createToolBus } from '@kernelpai/tools';
import { buildRegistry, kpaiHome, openJournal } from './env.js';
import { KernelError } from './errors.js';
import type { KernelHost } from './types.js';

export interface ProviderInfo {
  id: string;
  name: string;
  kind: string;
  jurisdiction: string;
  available: boolean;
  reason: string;
  models: Array<{
    id: string;
    contextWindow: number;
    price: { inputPerMTok: number; outputPerMTok: number };
  }>;
}

export interface ToolInfo {
  name: string;
  risk: string;
  source: string;
  description: string;
}

export class Queries {
  private opened: Journal | undefined;

  /** The journal is opened on first use: provider and tool listings never create one. */
  constructor(
    protected readonly host: KernelHost,
    journal?: Journal,
  ) {
    this.opened = journal;
  }

  protected get journal(): Journal {
    this.opened ??= openJournal(this.host.env, this.host.db);
    return this.opened;
  }

  protected closeJournal(): void {
    this.opened?.close();
    this.opened = undefined;
  }

  /** Detected providers, their models and price sheet. */
  async providers(): Promise<ProviderInfo[]> {
    const registry = buildRegistry(this.host.env, (t) => this.host.say?.(t));
    const adapters = registry.list();
    const detections = await Promise.all(adapters.map((a) => a.detect()));
    return adapters.map((a, i) => {
      const d = a.descriptor;
      const det = detections[i];
      return {
        id: d.id,
        name: d.name,
        kind: d.kind,
        jurisdiction: d.jurisdiction,
        available: det?.available === true,
        reason: det?.reason ?? '',
        models: a.capabilities().map((m) => ({
          id: m.id,
          contextWindow: m.contextWindow,
          price: { inputPerMTok: m.price.inputPerMTok, outputPerMTok: m.price.outputPerMTok },
        })),
      };
    });
  }

  /** Every tool models can be given, its risk and source; MCP servers that failed. */
  async tools(): Promise<{
    tools: ToolInfo[];
    errors: Array<{ server: string; message: string }>;
  }> {
    const { bus, mcpErrors } = await createToolBus({
      kpaiHome: kpaiHome(this.host.env),
      env: this.host.env,
    });
    try {
      const tools = bus.list().map((t) => ({
        name: t.name,
        risk: t.risk,
        source: t.source,
        description: t.description,
      }));
      return { tools, errors: mcpErrors.map((e) => ({ server: e.server, message: e.message })) };
    } finally {
      await bus.close();
    }
  }

  sessions(limit = 20): SessionRow[] {
    return this.journal.sessions(limit);
  }

  /** A session by id or unambiguous id prefix. */
  session(idOrPrefix: string): SessionRow {
    const s = this.journal.findSession(idOrPrefix);
    if (!s) throw new KernelError('not_found', `No session starting with "${idOrPrefix}"`);
    return s;
  }

  events(sessionIdOrPrefix: string, limit = 1000): JournalEvent[] {
    return this.journal.events({ sessionId: this.session(sessionIdOrPrefix).id, limit });
  }

  /** Phase metrics computed from the journal, for one session or all. */
  stats(sessionIdOrPrefix?: string): ExecutorMetrics {
    const sessionId = sessionIdOrPrefix ? this.session(sessionIdOrPrefix).id : undefined;
    return metrics(this.journal, sessionId ? { sessionId } : {});
  }

  verify(): ReturnType<Journal['verify']> {
    return this.journal.verify();
  }

  exportMarkdown(sessionIdOrPrefix: string): string {
    const s = this.session(sessionIdOrPrefix);
    return sessionToMarkdown(s, this.journal.events({ sessionId: s.id }));
  }
}
