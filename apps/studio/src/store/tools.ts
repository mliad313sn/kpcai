/**
 * Tools & skills tab: MCP servers and their pins (R-501, ADR-0032), skills, named agents
 * and hooks (R-502, ADR-0033), and local tickets. Read through `tools.list`,
 * `extensions.list` and `tickets.*`; a kernel that also offers `mcp.status` gives each
 * server's pin state and what changed, and with it the approve action (`mcp.approve`).
 * Every description, title and criterion is untrusted text, shown as text.
 */
import { createStore, useStore } from 'zustand';
import { z } from 'zod';
import type { MethodResult } from '../rpc/client';
import { isMethodNotFound, rawCall } from '../rpc/raw';
import { t } from '../i18n/core';
import { call, fail, requestPlan } from './actions';
import { announce, patch } from './store';

export type McpState = 'approved' | 'unapproved' | 'changed' | 'unreachable' | 'blocked';

export interface McpServerRow {
  server: string;
  status: McpState;
  version?: string;
  tools: string[];
  /** Tools whose calls are refused (their description is replaced by `[blocked]`). */
  blockedTools: string[];
  /** What changed since the approval, per tool (from `mcp.status`). */
  changes: string[];
  reason?: string;
  egress: string[];
  /** The tool-list hash a person would approve (from `mcp.status`). */
  hash?: string;
}

const McpStatusSchema = z.looseObject({
  servers: z.array(
    z.looseObject({
      server: z.string().max(200),
      status: z.enum(['approved', 'unapproved', 'changed', 'unreachable']),
      version: z.string().max(200).optional(),
      hash: z.string().max(200).optional(),
      tools: z.number().int().nonnegative(),
      egress: z.array(z.string().max(300)).max(100),
      changes: z.array(z.string().max(2000)).max(500),
      reason: z.string().max(2000).optional(),
    }),
  ),
});

const ApproveSchema = z.looseObject({ approved: z.boolean() });

export type Extensions = MethodResult<'extensions.list'>;
export type Ticket = MethodResult<'tickets.list'>['tickets'][number];
export type TicketShown = MethodResult<'tickets.show'>;

export interface ToolsState {
  loading: boolean;
  loaded: boolean;
  mcp: McpServerRow[];
  /** `status`: pin states from `mcp.status` (approve offered); `tools`: from the tool list. */
  mcpFrom: 'status' | 'tools';
  /** Built-in and pack tools by source, for the count line. */
  otherTools: number;
  extensions?: Extensions;
  tickets: Ticket[];
  ticketProblems: string[];
  shown?: TicketShown;
  /** The server whose approval waits for the person's confirmation. */
  approveAsk?: string;
  errors: string[];
}

export function initialTools(): ToolsState {
  return {
    loading: false,
    loaded: false,
    mcp: [],
    mcpFrom: 'tools',
    otherTools: 0,
    tickets: [],
    ticketProblems: [],
    errors: [],
  };
}

export const tools = createStore<ToolsState>(() => initialTools());

export function useTools<T>(selector: (s: ToolsState) => T): T {
  return useStore(tools, selector);
}

const BLOCKED = '[blocked]';

type ToolList = MethodResult<'tools.list'>;

/** Servers from the tool list: `mcp:<server>` sources; blocked tools; servers that failed. */
export function serversFromTools(list: ToolList): McpServerRow[] {
  const rows = new Map<string, McpServerRow>();
  const row = (server: string) => {
    let r = rows.get(server);
    if (!r) {
      r = { server, status: 'approved', tools: [], blockedTools: [], changes: [], egress: [] };
      rows.set(server, r);
    }
    return r;
  };
  for (const tool of list.tools) {
    if (!tool.source.startsWith('mcp:')) continue;
    const r = row(tool.source.slice(4));
    r.tools.push(tool.name);
    const desc = (tool as { description?: unknown }).description;
    if (typeof desc === 'string' && desc.startsWith(BLOCKED)) {
      r.blockedTools.push(tool.name);
      r.status = 'blocked';
    }
  }
  for (const e of list.errors) {
    const r = row(e.server);
    r.reason = e.message;
    if (r.tools.length === 0) r.status = 'unreachable';
  }
  return [...rows.values()].sort((a, b) => a.server.localeCompare(b.server));
}

function fromStatus(s: z.infer<typeof McpStatusSchema>, list: McpServerRow[]): McpServerRow[] {
  return s.servers.map((x) => {
    const known = list.find((r) => r.server === x.server);
    return {
      server: x.server,
      status: x.status,
      tools: known?.tools ?? [],
      blockedTools: known?.blockedTools ?? [],
      changes: x.changes,
      egress: x.egress,
      ...(x.version ? { version: x.version } : {}),
      ...(x.hash ? { hash: x.hash } : {}),
      ...(x.reason ? { reason: x.reason } : {}),
    };
  });
}

async function loadMcp(): Promise<Partial<ToolsState>> {
  const list = await call('tools.list', {});
  const derived = serversFromTools(list);
  const otherTools = list.tools.filter((x) => !x.source.startsWith('mcp:')).length;
  try {
    const status = await rawCall('mcp.status', {}, McpStatusSchema);
    return { mcp: fromStatus(status, derived), mcpFrom: 'status', otherTools };
  } catch (e) {
    if (!isMethodNotFound(e)) throw e;
    return { mcp: derived, mcpFrom: 'tools', otherTools };
  }
}

async function loadTickets(): Promise<Partial<ToolsState>> {
  const r = await call('tickets.list', {});
  return { tickets: r.tickets, ticketProblems: r.problems };
}

async function loadExtensions(): Promise<Partial<ToolsState>> {
  return { extensions: await call('extensions.list', {}) };
}

/** Loads the three panels side by side; one failing does not hide the others. */
export async function loadTools(): Promise<void> {
  tools.setState({ loading: true, errors: [] });
  const parts = await Promise.allSettled([loadMcp(), loadExtensions(), loadTickets()]);
  const next: Partial<ToolsState> = { loading: false, loaded: true, errors: [] };
  for (const p of parts) {
    if (p.status === 'fulfilled') Object.assign(next, p.value);
    else next.errors!.push(p.reason instanceof Error ? p.reason.message : String(p.reason));
  }
  tools.setState(next);
}

export async function showTicket(id: string): Promise<void> {
  try {
    tools.setState({ shown: await call('tickets.show', { id }) });
  } catch (e) {
    fail('tools.fail.ticket', e);
  }
}

/** A ticket becomes a plan like any request: shown first, run only on Run (principle 1). */
export async function planTicket(shown: TicketShown): Promise<void> {
  patch({ tab: 'conversation' });
  await requestPlan(shown.request, shown.options);
}

/** Approves exactly the tool list that was shown (its hash), after the person confirmed. */
export async function approveServer(row: McpServerRow): Promise<void> {
  tools.setState({ approveAsk: undefined });
  try {
    const r = await rawCall(
      'mcp.approve',
      { server: row.server, ...(row.hash ? { hash: row.hash } : {}) },
      ApproveSchema,
    );
    announce(
      t(r.approved ? 'tools.mcp.approved' : 'tools.mcp.notApproved', { server: row.server }),
    );
    await loadTools();
  } catch (e) {
    fail('tools.fail.approve', e);
  }
}
