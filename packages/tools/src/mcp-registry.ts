/**
 * The MCP registry (R-501, ADR-0032): servers come only from the allow-list in
 * `$KPAI_HOME/mcp.json`; each is checked against its pin (version + tool-list hash) on
 * connect and on every `tools/list_changed`; a server that is unapproved or changed has
 * every call refused until a person re-approves it; each server reaches the network only
 * through its own egress proxy.
 */
import type { Tool } from '@modelcontextprotocol/client';
import { startEgressProxy, type EgressDenial, type EgressProxy } from './egress-proxy.js';
import {
  exposeTools,
  MCP_CONNECT_TIMEOUT_MS,
  openMcpServer,
  type McpConfig,
  type McpConnection,
  type McpConnectResult,
  type McpServerConfig,
  type OpenedMcpServer,
} from './mcp.js';
import { checkPin, loadPins, snapshotTools, type McpPin, type McpPins } from './mcp-pin.js';

export interface PinnedMcpOptions {
  timeoutMs?: number;
  /** Told of each refused egress request (journal it; never blocks the proxy). */
  onEgressDenied?: (server: string, d: EgressDenial) => void;
}

export interface PinnedConnectResult extends McpConnectResult {
  /** Connected servers whose calls are refused, with the reason (show it to the user). */
  blocked: { server: string; reason: string }[];
}

/** A connection whose block reason can change (a later `tools/list_changed`). */
export interface PinnedConnection extends McpConnection {
  blockedReason(): string | undefined;
}

/** The latest reason wins only when there is none yet: a block is sticky for the connection. */
class BlockState {
  private why: string | undefined;
  constructor(
    private readonly server: string,
    private readonly pin: McpPin | undefined,
  ) {}

  get reason(): string | undefined {
    return this.why;
  }

  check(version: string, tools: readonly Tool[]): void {
    const c = checkPin(this.server, this.pin, version, snapshotTools(tools));
    if (c.status !== 'approved') this.why ??= c.reason;
  }

  fail(message: string): void {
    this.why ??= `MCP server "${this.server}" is blocked: ${message}`;
  }
}

/** Opens one server behind its egress proxy; the proxy is closed if the server fails. */
export async function openBehindProxy(
  server: string,
  cfg: McpServerConfig,
  options: PinnedMcpOptions & { onToolsChanged?: (t: Tool[] | null, e: Error | null) => void },
): Promise<{ opened: OpenedMcpServer; proxy: EgressProxy }> {
  const proxy = await startEgressProxy(server, cfg.egress, (d) =>
    options.onEgressDenied?.(server, d),
  );
  try {
    const opened = await openMcpServer(server, cfg, {
      timeoutMs: options.timeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
      env: proxy.env(),
      ...(options.onToolsChanged ? { onToolsChanged: options.onToolsChanged } : {}),
    });
    return { opened, proxy };
  } catch (err) {
    await proxy.close();
    throw err;
  }
}

/** Connects one allow-listed server and checks it against its pin. */
export async function connectPinnedServer(
  server: string,
  cfg: McpServerConfig,
  pin: McpPin | undefined,
  options: PinnedMcpOptions = {},
): Promise<PinnedConnection> {
  const state = new BlockState(server, pin);
  // A change notification may arrive before the first list is checked: kept for after.
  const seen: { version?: string; early?: Tool[] } = {};
  const onToolsChanged = (tools: Tool[] | null, error: Error | null): void => {
    if (error || !tools) return state.fail('its tool list could not be re-read after a change');
    if (seen.version === undefined) seen.early = tools;
    else state.check(seen.version, tools);
  };
  const { opened, proxy } = await openBehindProxy(server, cfg, { ...options, onToolsChanged });
  const version = opened.version;
  seen.version = version;
  state.check(version, opened.tools);
  if (seen.early !== undefined) state.check(version, seen.early);
  const guard = { blocked: () => state.reason };
  return {
    ...exposeTools(server, opened.client, opened.tools, guard),
    version,
    blockedReason: () => state.reason,
    close: async () => {
      await opened.client.close().catch(() => undefined);
      await proxy.close();
    },
  };
}

async function readPins(kpaiHome: string): Promise<{ pins: McpPins; error?: string }> {
  try {
    return { pins: await loadPins(kpaiHome) };
  } catch (err) {
    // A broken pin file approves nothing (fail closed); the servers still connect, blocked.
    return { pins: { servers: {} }, error: `mcp-pins.json ignored: ${(err as Error).message}` };
  }
}

/**
 * Connects every allow-listed server of `config`, pinned. Never throws: failures and
 * blocked servers are reported; blocked servers stay attached so their calls are refused
 * with the reason instead of failing as unknown tools.
 */
export async function connectPinnedServers(
  kpaiHome: string,
  config: McpConfig,
  options: PinnedMcpOptions = {},
): Promise<PinnedConnectResult> {
  const { pins, error } = await readPins(kpaiHome);
  const entries = Object.entries(config.servers);
  const settled = await Promise.allSettled(
    entries.map(([name, cfg]) => connectPinnedServer(name, cfg, pins.servers[name], options)),
  );
  const result: PinnedConnectResult = { connections: [], errors: [], blocked: [] };
  if (error) result.errors.push({ server: 'mcp-pins.json', message: error });
  settled.forEach((s, i) => {
    const server = entries[i]?.[0] ?? '?';
    if (s.status === 'rejected') {
      result.errors.push({ server, message: (s.reason as Error).message });
      return;
    }
    result.connections.push(s.value);
    const reason = s.value.blockedReason();
    if (reason !== undefined) result.blocked.push({ server, reason });
  });
  return result;
}
