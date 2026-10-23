/**
 * `kpai mcp list|approve|remove` (R-501, ADR-0032): inspect the allow-listed servers
 * against their pins, approve a server's current form after a person confirms (journaled),
 * and remove a server from the allow-list. Server text shown to the person is sanitised.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolJournal } from './bus.js';
import { loadMcpConfig, type McpServerConfig } from './mcp.js';
import {
  checkPin,
  loadPins,
  makePin,
  savePins,
  snapshotTools,
  toolsHash,
  type PinCheck,
  type ToolSnapshot,
} from './mcp-pin.js';
import { openBehindProxy } from './mcp-registry.js';
import { stripControls } from './text.js';

export interface McpServerStatus {
  server: string;
  status: PinCheck['status'] | 'unreachable';
  /** Version reported now (absent when unreachable). */
  version?: string;
  hash?: string;
  pinnedHash?: string;
  tools: number;
  egress: string[];
  changes: string[];
  reason?: string;
}

interface Inspected {
  version: string;
  tools: ToolSnapshot[];
}

async function inspect(server: string, cfg: McpServerConfig, timeoutMs?: number) {
  const { opened, proxy } = await openBehindProxy(server, cfg, { timeoutMs });
  try {
    return { version: opened.version, tools: snapshotTools(opened.tools) } satisfies Inspected;
  } finally {
    await opened.client.close().catch(() => undefined);
    await proxy.close();
  }
}

/** Every allow-listed server: reachable or not, approved, unapproved or changed. */
export async function mcpStatus(kpaiHome: string, timeoutMs?: number): Promise<McpServerStatus[]> {
  const config = await loadMcpConfig(kpaiHome);
  const pins = await loadPins(kpaiHome);
  const rows = Object.entries(config.servers).map(async ([server, cfg]) => {
    const pin = pins.servers[server];
    const base = { server, egress: cfg.egress, ...(pin ? { pinnedHash: pin.hash } : {}) };
    try {
      const now = await inspect(server, cfg, timeoutMs);
      const c = checkPin(server, pin, now.version, now.tools);
      return {
        ...base,
        status: c.status,
        version: now.version,
        hash: toolsHash(now.tools),
        tools: now.tools.length,
        changes: c.changes,
        ...(c.reason ? { reason: c.reason } : {}),
      };
    } catch (err) {
      const reason = stripControls((err as Error).message).slice(0, 500);
      return { ...base, status: 'unreachable' as const, tools: 0, changes: [], reason };
    }
  });
  return Promise.all(rows);
}

export interface ApproveOptions {
  /** Asks the person; false (or a throw) approves nothing. */
  confirm(question: string): Promise<boolean>;
  journal?: ToolJournal;
  sessionId: string;
  timeoutMs?: number;
}

export interface ApproveResult {
  approved: boolean;
  message: string;
  hash?: string;
}

const line = (s: string | undefined, max: number): string =>
  stripControls((s ?? '').split(/\r?\n/)[0] ?? '').slice(0, max);

function question(server: string, now: Inspected, changes: string[], first: boolean): string {
  const head = first
    ? `Approve MCP server "${server}" (version ${line(now.version, 40) || '?'}) with ${now.tools.length} tool(s)?`
    : `Re-approve MCP server "${server}" (version ${line(now.version, 40) || '?'})? It changed:`;
  const diff = first ? [] : changes.slice(0, 20).map((c) => `  - ${c}`);
  const tools = now.tools
    .slice(0, 20)
    .map((t) => `  ${line(t.name, 64)}: ${line(t.description, 100)}`);
  const more = now.tools.length > 20 ? [`  … and ${now.tools.length - 20} more`] : [];
  const note =
    'Tool descriptions are untrusted text from the server; approve only what you expect.';
  return [head, ...diff, 'Tools:', ...tools, ...more, note].join('\n');
}

function record(o: ApproveOptions, payload: Record<string, unknown>): void {
  try {
    o.journal?.append({ sessionId: o.sessionId, type: 'intervention', payload });
  } catch {
    // A journal failure does not undo the person's decision.
  }
}

/**
 * Shows the server's current tools (and what changed) and pins them when the person says
 * yes. The decision is journaled either way. Only an allow-listed server can be approved.
 */
export async function approveMcpServer(
  kpaiHome: string,
  server: string,
  o: ApproveOptions,
): Promise<ApproveResult> {
  const cfg = (await loadMcpConfig(kpaiHome)).servers[server];
  if (!cfg) {
    return { approved: false, message: `"${server}" is not in the allow-list (mcp.json)` };
  }
  const pins = await loadPins(kpaiHome);
  const pin = pins.servers[server];
  const now = await inspect(server, cfg, o.timeoutMs);
  const check = checkPin(server, pin, now.version, now.tools);
  const hash = toolsHash(now.tools);
  if (check.status === 'approved') {
    return { approved: true, hash, message: `"${server}" is already approved as it is` };
  }
  const yes = await o.confirm(question(server, now, check.changes, !pin)).catch(() => false);
  const payload = {
    server,
    version: now.version,
    hash,
    previousHash: pin?.hash ?? null,
    tools: now.tools.map((t) => t.name),
    changes: check.changes.slice(0, 50),
  };
  if (!yes) {
    record(o, { action: 'mcp approval declined', ...payload });
    return { approved: false, message: `"${server}" stays blocked (not approved)` };
  }
  pins.servers[server] = makePin(now.version, now.tools);
  await savePins(kpaiHome, pins);
  record(o, { action: 'mcp approved', ...payload });
  return { approved: true, hash, message: `"${server}" approved (${hash.slice(0, 12)})` };
}

/** Removes the server from the allow-list and drops its pin (journaled). */
export async function removeMcpServer(
  kpaiHome: string,
  server: string,
  o: Pick<ApproveOptions, 'journal' | 'sessionId'>,
): Promise<{ removed: boolean; message: string }> {
  const file = path.join(kpaiHome, 'mcp.json');
  await loadMcpConfig(kpaiHome); // validates the file before rewriting it
  const raw = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as {
    servers?: Record<string, unknown>;
  };
  const pins = await loadPins(kpaiHome);
  const listed = raw.servers !== undefined && Object.hasOwn(raw.servers, server);
  const pinned = Object.hasOwn(pins.servers, server);
  if (!listed && !pinned) return { removed: false, message: `"${server}" is not configured` };
  if (listed && raw.servers) {
    delete raw.servers[server];
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  }
  if (pinned) {
    delete pins.servers[server];
    await savePins(kpaiHome, pins);
  }
  record({ ...o, confirm: async () => false }, { action: 'mcp removed', server });
  return { removed: true, message: `"${server}" removed from the allow-list` };
}
