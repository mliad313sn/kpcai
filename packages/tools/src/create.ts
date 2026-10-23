import type { PermissionPolicy } from '@kernelpai/core';
import { builtinTools, type BuiltinOptions } from './builtins/index.js';
import { LocalToolBus, type ToolJournal } from './bus.js';
import type { Env } from './env.js';
import { connectMcpServers, loadMcpConfig, type McpConnectResult } from './mcp.js';

export interface CreateToolBusOptions extends BuiltinOptions {
  /** When set, MCP servers from `$KPAI_HOME/mcp.json` are connected. */
  kpaiHome?: string;
  journal?: ToolJournal;
  policy?: PermissionPolicy;
  maxResultBytes?: number;
  mcpConnectTimeoutMs?: number;
}

export interface CreatedToolBus {
  bus: LocalToolBus;
  /** MCP servers that failed to start or a broken mcp.json (the bus still works). */
  mcpErrors: McpConnectResult['errors'];
}

/** Builds the bus with all built-ins plus the configured MCP servers. Never throws for MCP. */
export async function createToolBus(options: CreateToolBusOptions = {}): Promise<CreatedToolBus> {
  const env: Env = options.env ?? process.env;
  const bus = new LocalToolBus({
    tools: builtinTools({ env, git: options.git, shell: options.shell }),
    policy: options.policy,
    journal: options.journal,
    maxResultBytes: options.maxResultBytes,
    env,
  });
  if (options.kpaiHome === undefined) return { bus, mcpErrors: [] };
  let connected: McpConnectResult;
  try {
    const config = await loadMcpConfig(options.kpaiHome);
    connected = await connectMcpServers(config, options.mcpConnectTimeoutMs);
  } catch (err) {
    return { bus, mcpErrors: [{ server: 'mcp.json', message: (err as Error).message }] };
  }
  const mcpErrors = [...connected.errors];
  for (const c of connected.connections) {
    try {
      bus.attach(c);
    } catch (err) {
      mcpErrors.push({ server: c.server, message: (err as Error).message });
      await c.close().catch(() => undefined);
    }
  }
  return { bus, mcpErrors };
}
