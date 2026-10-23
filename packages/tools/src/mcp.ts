import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolRisk } from '@kernelpai/core';
import { Client, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { stripControls } from './text.js';
import type { LocalTool, ToolOutcome } from './types.js';

const ServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  /**
   * Hosts the server may reach through its egress proxy (R-501): `host`, `host:port` or
   * `*.domain`. Empty (the default) refuses every outbound HTTP(S) request.
   */
  egress: z.array(z.string().min(1).max(253)).default([]),
});
export const McpConfigSchema = z.object({
  servers: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/), ServerConfigSchema).default({}),
});
export type McpServerConfig = z.infer<typeof ServerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;

export const MCP_CONNECT_TIMEOUT_MS = 15_000;
export const MCP_CALL_TIMEOUT_MS = 60_000;
const STDERR_TAIL = 2048;

/**
 * Reads `$KPAI_HOME/mcp.json`; a missing file (or missing home) means no servers.
 * Throws on invalid JSON/shape, and when `kpaiHome` exists but is not a folder:
 * POSIX reports that as ENOTDIR while Windows reports ENOENT, so it is checked here.
 */
export async function loadMcpConfig(kpaiHome: string): Promise<McpConfig> {
  // Checked first so every OS takes the same path (see above).
  const home = await stat(kpaiHome).catch(() => undefined);
  if (home === undefined) return { servers: {} };
  if (!home.isDirectory()) throw new Error(`KPAI_HOME is not a directory: ${kpaiHome}`);
  let raw: string;
  try {
    raw = await readFile(path.join(kpaiHome, 'mcp.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { servers: {} };
    throw err;
  }
  return McpConfigSchema.parse(JSON.parse(raw));
}

/**
 * Risk from MCP annotations, as decided in the phase-2 plan: `readOnlyHint` →
 * read, `destructiveHint` → destructive, otherwise write. Annotations are hints
 * from the server, not guarantees.
 */
export function riskFromAnnotations(a: Tool['annotations']): ToolRisk {
  if (a?.readOnlyHint === true) return 'read';
  // MCP spec: destructiveHint defaults to true for tools that are not read-only (PO decision D-012).
  if (a?.destructiveHint === false) return 'write';
  return 'destructive';
}

/** `mcp.<server>.<tool>`, sanitised to the ToolCall name alphabet; undefined when too long. */
export function mcpToolName(server: string, tool: string): string | undefined {
  const name = `mcp.${server}.${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  return name.length <= 64 ? name : undefined;
}

/** Flattens MCP content blocks into text; non-text blocks become short placeholders. */
export function resultText(result: CallToolResult): string {
  const parts = (result.content ?? []).map((b) => {
    switch (b.type) {
      case 'text':
        return b.text;
      case 'image':
      case 'audio':
        return `[${b.type}: ${b.mimeType}]`;
      case 'resource':
        return 'text' in b.resource ? b.resource.text : `[resource: ${b.resource.uri}]`;
      case 'resource_link':
        return `[resource link: ${b.uri}]`;
      default:
        return '[unsupported content]';
    }
  });
  if (parts.length === 0 && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return parts.join('\n');
}

export interface McpConnection {
  server: string;
  /** The server's `serverInfo.version` from the MCP handshake ('' when absent). */
  version?: string;
  tools: LocalTool[];
  /** Tools that could not be exposed (name too long, duplicate). */
  skipped: string[];
  close(): Promise<void>;
}

/** Decides, before every call, whether a server's tools may run (pinning, R-501). */
export interface McpGuard {
  /** Why calls are refused right now; undefined lets them through. */
  blocked(): string | undefined;
}

/**
 * The definition shown to models. A server blocked when its tools are exposed shows no
 * text of its own (that text is what changed): a fixed notice and an open schema, so a
 * call reaches the bus and is refused there with the reason.
 */
function toolDef(server: string, tool: Tool, name: string, guard?: McpGuard): LocalTool['def'] {
  const source = `mcp:${server}`;
  if (guard?.blocked() !== undefined) {
    const description = `[blocked] MCP server ${server} is not approved in its current form; calls are refused.`;
    return { name, description, inputSchema: { type: 'object' }, risk: 'destructive', source };
  }
  return {
    name,
    description: stripControls(tool.description ?? tool.title ?? tool.name).slice(0, 1024),
    inputSchema: tool.inputSchema as Record<string, unknown>,
    risk: riskFromAnnotations(tool.annotations),
    source,
  };
}

function toLocalTool(
  server: string,
  client: Client,
  tool: Tool,
  name: string,
  guard?: McpGuard,
): LocalTool {
  return {
    def: toolDef(server, tool, name, guard),
    ...(guard ? { blocked: () => guard.blocked() } : {}),
    async run(input, ctx): Promise<ToolOutcome> {
      // Checked again here: the bus checks first, this covers a direct caller.
      const reason = guard?.blocked();
      if (reason !== undefined) return { content: reason, isError: true };
      const result = await client.callTool(
        { name: tool.name, arguments: input },
        { signal: ctx.signal, timeout: MCP_CALL_TIMEOUT_MS },
      );
      const meta = { server, tool: tool.name };
      return { content: resultText(result), isError: result.isError === true, meta };
    },
  };
}

export function exposeTools(
  server: string,
  client: Client,
  tools: Tool[],
  guard?: McpGuard,
): Omit<McpConnection, 'close'> {
  const out: LocalTool[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    const name = mcpToolName(server, t.name);
    if (name === undefined || seen.has(name)) {
      skipped.push(t.name);
      continue;
    }
    seen.add(name);
    out.push(toLocalTool(server, client, t, name, guard));
  }
  return { server, tools: out, skipped };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** An open MCP client with the server's version and tool list, not yet exposed. */
export interface OpenedMcpServer {
  client: Client;
  version: string;
  tools: Tool[];
}

export interface OpenMcpOptions {
  timeoutMs?: number;
  /** Set after the configured env (the egress proxy variables win). */
  env?: Record<string, string>;
  /** Called with the new tool list after a `tools/list_changed` notification. */
  onToolsChanged?: (tools: Tool[] | null, error: Error | null) => void;
}

/**
 * Spawns one stdio MCP server (no shell; env = the SDK's safe defaults + the configured
 * `env` + `options.env`) and lists its tools.
 */
export async function openMcpServer(
  server: string,
  cfg: McpServerConfig,
  options: OpenMcpOptions = {},
): Promise<OpenedMcpServer> {
  const timeoutMs = options.timeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: { ...cfg.env, ...options.env },
    cwd: cfg.cwd,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString('utf8')).slice(-STDERR_TAIL);
  });
  const onChanged = options.onToolsChanged;
  const client = new Client(
    { name: 'kernelpai', version: '0.0.1' },
    onChanged
      ? {
          listChanged: {
            tools: { debounceMs: 0, onChanged: (error, tools) => onChanged(tools, error) },
          },
        }
      : {},
  );
  try {
    await withTimeout(client.connect(transport), timeoutMs, `MCP server ${server} connect`);
    const listed = await withTimeout(
      client.listTools(),
      timeoutMs,
      `MCP server ${server} tools/list`,
    );
    return { client, version: client.getServerVersion()?.version ?? '', tools: listed.tools };
  } catch (err) {
    await client.close().catch(() => undefined);
    const tail = stderr.trim() ? `; stderr: ${stripControls(stderr.trim()).slice(-500)}` : '';
    throw new Error(`MCP server ${server}: ${(err as Error).message}${tail}`, {
      cause: err,
    });
  }
}

/**
 * Spawns one stdio MCP server and wraps its tools as `mcp.<server>.<tool>`, without
 * pinning: the registry (`mcp-registry.ts`) is what runs use (R-501).
 */
export async function connectMcpServer(
  server: string,
  cfg: McpServerConfig,
  timeoutMs = MCP_CONNECT_TIMEOUT_MS,
): Promise<McpConnection> {
  const { client, version, tools } = await openMcpServer(server, cfg, { timeoutMs });
  return { ...exposeTools(server, client, tools), version, close: () => client.close() };
}

export interface McpConnectResult {
  connections: McpConnection[];
  /** Servers that failed to start; the others still connect. Messages hold no env values. */
  errors: { server: string; message: string }[];
}

export async function connectMcpServers(
  config: McpConfig,
  timeoutMs = MCP_CONNECT_TIMEOUT_MS,
): Promise<McpConnectResult> {
  const entries = Object.entries(config.servers);
  const settled = await Promise.allSettled(
    entries.map(([name, cfg]) => connectMcpServer(name, cfg, timeoutMs)),
  );
  const result: McpConnectResult = { connections: [], errors: [] };
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') result.connections.push(s.value);
    else
      result.errors.push({ server: entries[i]?.[0] ?? '?', message: (s.reason as Error).message });
  });
  return result;
}
