/**
 * Tickets for front ends (ADR-0033): list, show, the run request of a ticket, and the
 * write-back of a run's outcome to the ticket's status, only after a human confirms the
 * exact new file. The write goes through the tool bus (`fs.write`: jailed, zones,
 * journaled); a declined or unanswered question writes nothing.
 */
import { readFile } from 'node:fs/promises';
import type { Journal } from '@kernelpai/journal';
import { createToolBus, resolveInRoot, type ZoneSet } from '@kernelpai/tools';
import type { Confirm } from './confirm.js';
import type { Env } from './env.js';
import { KernelError } from './errors.js';
import { policyFor } from './packs.js';
import {
  TICKET_DIR,
  listTickets,
  readTicket,
  ticketRequest,
  withStatus,
  type Ticket,
  type TicketStatus,
} from './tickets.js';

const RAW_MAX_BYTES = 256 * 1024;

export interface TicketsHost {
  env: Env;
  cwd: string;
  journal(): Journal;
  confirm: Confirm;
  /** The session a ticket action is journaled in. */
  session(title: string): string;
}

export interface TicketRun {
  ticket: Ticket;
  /** The run's goal and exit criteria, the ticket quoted as untrusted text. */
  request: string;
  /** The ticket's skill and agent, which can only narrow the nodes (R-502). */
  options: { skill?: string; agent?: string };
}

export class KernelTickets {
  constructor(private readonly h: TicketsHost) {}

  private async zones(): Promise<ZoneSet> {
    return (await policyFor(this.h.env, undefined, undefined, this.h.cwd)).policy.zoneSet();
  }

  list(): Promise<{ tickets: Ticket[]; problems: string[] }> {
    return this.zones().then((z) => listTickets(this.h.cwd, z));
  }

  async show(id: string): Promise<Ticket> {
    const t = await readTicket(this.h.cwd, id, await this.zones());
    if (t === undefined) throw new KernelError('not_found', `no ticket ${id.slice(0, 80)}`);
    if (typeof t === 'string') throw new KernelError('invalid', t);
    return t;
  }

  /** What `kpai ticket run` starts: the request and the ticket's assignments. */
  async forRun(id: string): Promise<TicketRun> {
    const ticket = await this.show(id);
    const options = {
      ...(ticket.skill ? { skill: ticket.skill } : {}),
      ...(ticket.agent ? { agent: ticket.agent } : {}),
    };
    return { ticket, request: ticketRequest(ticket), options };
  }

  /**
   * Sets a ticket's status after the human confirms the exact new file. Returns whether it
   * was written; never writes on a no, silence or an error.
   */
  async setStatus(
    id: string,
    status: TicketStatus,
    runId?: string,
  ): Promise<{ written: boolean; status: TicketStatus; message: string }> {
    await this.show(id);
    const rel = `${TICKET_DIR}/${id}.md`;
    const j = await resolveInRoot(this.h.cwd, rel, { mustExist: true, noFinalSymlink: true });
    const raw = await readFile(j.abs, 'utf8');
    if (Buffer.byteLength(raw) > RAW_MAX_BYTES)
      throw new KernelError('refused', `ticket ${id} is too large to rewrite`);
    const content = withStatus(raw, status);
    const meta = {
      path: rel,
      kind: 'ticket',
      mime: 'text/markdown',
      bytes: Buffer.byteLength(content),
      nodeId: 'ticket',
      // Written by KernelPAI (one front matter line), not model output.
      reviewed: true,
    };
    const question = `Set ticket ${id} status to "${status}" in ${rel}?`;
    const ask = (q: string): Promise<boolean> =>
      this.h.confirm({
        kind: 'artifact',
        question: q,
        content,
        artifact: meta,
        risk: 'write',
        inWorktree: false,
        ...(runId ? { runId } : {}),
      });
    if (!(await ask(question).catch(() => false)))
      return { written: false, status, message: 'not written: declined' };
    return this.write(id, rel, content, status, runId);
  }

  private async write(
    id: string,
    rel: string,
    content: string,
    status: TicketStatus,
    runId: string | undefined,
  ): Promise<{ written: boolean; status: TicketStatus; message: string }> {
    const journal = this.h.journal();
    const { policy } = await policyFor(this.h.env, undefined, undefined, this.h.cwd);
    const { bus } = await createToolBus({ policy, journal, env: this.h.env });
    const sessionId = this.h.session(`ticket ${id}`);
    try {
      const r = await bus.call(
        { id: `ticket-${id}`, name: 'fs.write', input: { path: rel, content } },
        {
          model: { provider: 'kernel', model: 'ticket' },
          root: this.h.cwd,
          sessionId,
          nodeId: `ticket-${id}`,
          // Asked above with this exact content.
          confirm: () => Promise.resolve(true),
        },
      );
      const payload = { action: 'ticket status', ticket: id, status, ok: !r.isError, runId };
      journal.append({ sessionId, type: 'intervention', payload });
      return { written: !r.isError, status, message: r.content.slice(0, 300) };
    } finally {
      await bus.close();
    }
  }
}
