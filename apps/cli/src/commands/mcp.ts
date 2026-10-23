/**
 * `kpai mcp list|approve|remove` (R-501, ADR-0032): the MCP allow-list in
 * `$KPAI_HOME/mcp.json` and the pins in `$KPAI_HOME/mcp-pins.json`. Approving shows the
 * server's tools (and what changed) and always asks the person; the answer is journaled.
 */
import { kpaiHome } from '@kernelpai/kernel';
import { approveMcpServer, mcpStatus, removeMcpServer } from '@kernelpai/tools';
import { openJournal } from '../context.js';
import type { Io } from '../io.js';
import { sanitizeForTerminal } from '../sanitize.js';

export const MCP_USAGE = `kpai mcp list                  Allow-listed MCP servers: approved, changed, unapproved
kpai mcp approve <server>      Review a server's tools and pin them (version + hash)
kpai mcp remove <server>       Remove a server from the allow-list and drop its pin
`;

const t = (s: string): string => sanitizeForTerminal(s);

async function list(io: Io): Promise<number> {
  const rows = await mcpStatus(kpaiHome(io.env));
  if (rows.length === 0) io.out('no MCP server in $KPAI_HOME/mcp.json\n');
  for (const r of rows) {
    const hash = r.hash ? r.hash.slice(0, 12) : '-';
    const egress = r.egress.length > 0 ? r.egress.join(',') : 'none';
    io.out(
      `${t(r.server).padEnd(20)} ${r.status.padEnd(11)} v${t(r.version ?? '?').padEnd(10)} ${hash}  ${r.tools} tool(s)  egress: ${t(egress)}\n`,
    );
    for (const c of r.changes.slice(0, 10)) io.out(`  - ${t(c)}\n`);
    if (r.status !== 'approved' && r.reason) io.out(`  ${t(r.reason)}\n`);
  }
  return rows.some((r) => r.status !== 'approved') ? 1 : 0;
}

async function withJournal<T>(
  io: Io,
  o: McpCliOptions,
  title: string,
  f: (j: ReturnType<typeof openJournal>, sessionId: string) => Promise<T>,
): Promise<T> {
  const journal = openJournal(io.env, o.db);
  try {
    return await f(journal, journal.startSession(title, io.cwd));
  } finally {
    journal.close();
  }
}

export interface McpCliOptions {
  db?: string | undefined;
}

/** `kpai mcp …`; exit 0 on success, 1 when something is not approved or not found, 2 on usage. */
export async function mcpCommand(io: Io, rest: string[], o: McpCliOptions = {}): Promise<number> {
  const [sub, server, ...extra] = rest;
  if (sub === 'list' && server === undefined) return list(io);
  if ((sub === 'approve' || sub === 'remove') && server && extra.length === 0) {
    const home = kpaiHome(io.env);
    if (sub === 'approve') {
      const r = await withJournal(io, o, `kpai mcp approve ${server}`, (journal, sessionId) =>
        approveMcpServer(home, server, { confirm: (q) => io.confirm(q), journal, sessionId }),
      );
      (r.approved ? io.out : io.err)(`${t(r.message)}\n`);
      return r.approved ? 0 : 1;
    }
    const r = await withJournal(io, o, `kpai mcp remove ${server}`, (journal, sessionId) =>
      removeMcpServer(home, server, { journal, sessionId }),
    );
    (r.removed ? io.out : io.err)(`${t(r.message)}\n`);
    return r.removed ? 0 : 1;
  }
  io.err(MCP_USAGE);
  return 2;
}
