/**
 * `kpai ticket list|show|run <id>` (ADR-0033): local Markdown tickets in
 * `.kpstudio/tickets/`. A ticket is untrusted repository text: shown sanitized, run as a
 * quoted goal with its exit criteria; the outcome is written to its status only when you
 * say yes to the exact change.
 */
import { statusFor, type Kernel, type Ticket } from '@kernelpai/kernel';
import { sanitizeForTerminal as clean } from '../sanitize.js';
import type { Io } from '../io.js';
import { finishRun, notRun, open, planText, type GraphCliOptions } from './graph.js';

export type TicketCliOptions = Omit<GraphCliOptions, 'request'>;

function line(t: Ticket): string {
  const extra = [t.skill && `skill ${t.skill}`, t.agent && `agent ${t.agent}`].filter(Boolean);
  const tail = extra.length ? `  (${extra.join(', ')})` : '';
  return `${t.id.padEnd(20)} ${t.status.padEnd(12)} ${clean(t.title)}${tail}\n`;
}

async function list(io: Io, kernel: Kernel): Promise<number> {
  const r = await kernel.tickets.list();
  if (r.tickets.length === 0) io.out('no tickets in .kpstudio/tickets/\n');
  for (const t of r.tickets) io.out(line(t));
  for (const p of r.problems) io.err(`  – ${clean(p)}\n`);
  return 0;
}

async function show(io: Io, kernel: Kernel, id: string): Promise<number> {
  const r = await kernel.tickets.forRun(id);
  io.out(line(r.ticket));
  io.out(`path ${clean(r.ticket.path)} (untrusted text)\n`);
  io.out(`--- run request ---\n${clean(r.request)}\n`);
  return 0;
}

/** Plans and runs the ticket, then offers to write the outcome to its status. */
async function run(io: Io, kernel: Kernel, id: string, o: TicketCliOptions): Promise<number> {
  const r = await kernel.tickets.forRun(id);
  // The ticket's own skill and agent apply unless you named others on the command line.
  const opts: GraphCliOptions = { ...r.options, ...o, request: r.request };
  const sessionId = kernel.openSession(`ticket ${id}`, !o.newSession);
  await kernel.checkWorkspace();
  const p = await kernel.plan(r.request, opts, sessionId);
  io.err(planText(p));
  const handle = await kernel.startRun({ request: r.request, planId: p.planId, options: opts });
  const code = await finishRun(io, kernel, p, handle, o);
  const outcome = kernel.runInfo(handle.runId).outcome;
  if (outcome?.status !== 'finished') return code;
  const status = statusFor(outcome);
  io.err(`ticket ${id}: status ${r.ticket.status} → ${status} (asks before writing)\n`);
  const w = await kernel.tickets.setStatus(id, status, handle.runId);
  io.err(w.written ? `ticket ${id} is now ${status}\n` : `ticket ${id} unchanged (${w.message})\n`);
  return code;
}

export async function ticketCommand(
  io: Io,
  rest: readonly string[],
  o: TicketCliOptions,
): Promise<number> {
  const [sub, id, ...extra] = rest;
  const needsId = sub === 'show' || sub === 'run';
  if (!sub || !['list', 'show', 'run'].includes(sub) || (needsId && !id) || extra.length > 0) {
    io.err('usage: kpai ticket list | kpai ticket show <id> | kpai ticket run <id> [flags]\n');
    return 2;
  }
  const kernel = open(io, o);
  try {
    if (sub === 'list') return await list(io, kernel);
    if (sub === 'show') return await show(io, kernel, id!);
    return await run(io, kernel, id!, o);
  } catch (err) {
    return notRun(io, err);
  } finally {
    await kernel.close();
  }
}
