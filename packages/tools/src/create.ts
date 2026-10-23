import type { PermissionPolicy } from '@kernelpai/core';
import { builtinTools, type BuiltinOptions } from './builtins/index.js';
import { LocalToolBus, type ToolJournal } from './bus.js';
import type { Env } from './env.js';
import { connectMcpServers, loadMcpConfig, type McpConnectResult } from './mcp.js';
import {
  DEFAULT_FORBIDDEN_PATHS,
  type ActivePolicy,
  type GradedPermissionPolicy,
  type GradedPolicyOptions,
} from './policy.js';
import { buildPolicy, loadPolicyConfig } from './policy-config.js';

export interface CreateToolBusOptions extends BuiltinOptions {
  /** When set, MCP servers from `$KPAI_HOME/mcp.json` are connected. */
  kpaiHome?: string;
  journal?: ToolJournal;
  /** Replaces the graded policy entirely (defaults and policy.json are then not used). */
  policy?: PermissionPolicy;
  /** Extra forbidden globs / per-model denies on top of defaults and policy.json. */
  policyOptions?: GradedPolicyOptions;
  maxResultBytes?: number;
  mcpConnectTimeoutMs?: number;
}

export interface CreatedToolBus {
  bus: LocalToolBus;
  /** MCP servers that failed to start or a broken mcp.json (the bus still works). */
  mcpErrors: McpConnectResult['errors'];
  /** The graded policy in force (absent when a custom `policy` was passed). */
  activePolicy?: ActivePolicy;
  /** A broken `$KPAI_HOME/policy.json` (defaults still apply). */
  policyError?: string;
}

/** Builds the bus with all built-ins plus the configured MCP servers. Never throws for MCP. */
export async function createToolBus(options: CreateToolBusOptions = {}): Promise<CreatedToolBus> {
  const env: Env = options.env ?? process.env;
  const { policy, ...status } = await resolvePolicy(options);
  const bus = new LocalToolBus({
    tools: builtinTools({ env, git: gitOptions(options, policy), shell: options.shell }),
    policy,
    journal: options.journal,
    maxResultBytes: options.maxResultBytes,
    env,
  });
  const mcpErrors = await attachMcp(bus, options);
  return { bus, mcpErrors, ...status };
}

/**
 * The git read tools hide the same forbidden zones the policy refuses (review N2):
 * the active graded policy's list, or the defaults for a custom policy that cannot
 * describe itself. An explicit `git.forbiddenPaths` wins.
 */
function gitOptions(options: CreateToolBusOptions, policy: PermissionPolicy) {
  const described = (policy as Partial<GradedPermissionPolicy>).describe?.();
  const forbiddenPaths =
    options.git?.forbiddenPaths ?? described?.forbiddenPaths ?? DEFAULT_FORBIDDEN_PATHS;
  return { ...options.git, forbiddenPaths };
}

/** Defaults (principle 5) + `$KPAI_HOME/policy.json` + `policyOptions`, unless a policy is given. */
async function resolvePolicy(
  options: CreateToolBusOptions,
): Promise<{ policy: PermissionPolicy; activePolicy?: ActivePolicy; policyError?: string }> {
  if (options.policy) return { policy: options.policy };
  const loaded =
    options.kpaiHome === undefined ? undefined : await loadPolicyConfig(options.kpaiHome);
  const config = loaded?.config ?? { forbiddenPaths: [], denyByModel: {} };
  const policy = buildPolicy(config, options.policyOptions);
  const out = { policy, activePolicy: policy.describe() };
  return loaded?.error ? { ...out, policyError: loaded.error } : out;
}

async function attachMcp(
  bus: LocalToolBus,
  options: CreateToolBusOptions,
): Promise<McpConnectResult['errors']> {
  if (options.kpaiHome === undefined) return [];
  let connected: McpConnectResult;
  try {
    const config = await loadMcpConfig(options.kpaiHome);
    connected = await connectMcpServers(config, options.mcpConnectTimeoutMs);
  } catch (err) {
    return [{ server: 'mcp.json', message: (err as Error).message }];
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
  return mcpErrors;
}
