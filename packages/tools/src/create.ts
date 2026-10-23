import type { PermissionPolicy } from '@kernelpai/core';
import { builtinTools, type BuiltinOptions } from './builtins/index.js';
import { LocalToolBus, type ToolJournal } from './bus.js';
import type { Env } from './env.js';
import { connectMcpServers, loadMcpConfig, type McpConnectResult } from './mcp.js';
import { journalPackZones, planPackZones, type PackZoneOptions } from './pack-zones.js';
import type { ActivePolicy, GradedPermissionPolicy, GradedPolicyOptions } from './policy.js';
import { buildPolicy, loadPolicyConfig } from './policy-config.js';
import { EMPTY_PACK_ZONES, type PackZonePlan } from './zone-set.js';
import { DEFAULT_ZONES, zoneSetFromGlobs, type ZoneSet } from './zones.js';

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
  /**
   * Zone additions and relaxations of the packs the user enabled (WI-S5-01). Additions
   * always apply; a relaxation applies only to the name heuristics, only once approved
   * (`approved`), and only when it can be journaled (`journal` is required for it).
   * Ignored, except for reporting, when a custom `policy` is passed.
   */
  packs?: PackZoneOptions;
}

export interface CreatedToolBus {
  bus: LocalToolBus;
  /** MCP servers that failed to start or a broken mcp.json (the bus still works). */
  mcpErrors: McpConnectResult['errors'];
  /** The graded policy in force (absent when a custom `policy` was passed). */
  activePolicy?: ActivePolicy;
  /** A broken `$KPAI_HOME/policy.json` (defaults still apply). */
  policyError?: string;
  /**
   * What the enabled packs did to the zones: additions, relaxations in force, relaxations
   * waiting for the user's approval (show them), refusals with their reason.
   */
  packZones: PackZonePlan;
}

/** Builds the bus with all built-ins plus the configured MCP servers. Never throws for MCP. */
export async function createToolBus(options: CreateToolBusOptions = {}): Promise<CreatedToolBus> {
  const env: Env = options.env ?? process.env;
  const packZones = resolvePackZones(options);
  const { policy, ...status } = await resolvePolicy(options, packZones);
  const bus = new LocalToolBus({
    tools: builtinTools({ env, git: gitOptions(options, policy), shell: options.shell }),
    policy,
    journal: options.journal,
    maxResultBytes: options.maxResultBytes,
    env,
  });
  const mcpErrors = await attachMcp(bus, options);
  return { bus, mcpErrors, ...status, packZones };
}

/**
 * The git read tools hide the same forbidden zones the policy refuses (review N2):
 * the active graded policy's zone set (with pack additions and relaxations), or the
 * defaults for a custom policy that cannot describe itself. An explicit
 * `git.zones` / `git.forbiddenPaths` wins (the credential tier is always added).
 */
function gitOptions(options: CreateToolBusOptions, policy: PermissionPolicy) {
  const own = (policy as Partial<GradedPermissionPolicy>).zoneSet?.();
  const explicit = options.git?.forbiddenPaths;
  const ci = options.git?.caseInsensitive;
  const zones: ZoneSet =
    options.git?.zones ??
    (explicit ? zoneSetFromGlobs(explicit, ci) : (own ?? zoneSetFromGlobs(DEFAULT_ZONES, ci)));
  return { ...options.git, zones };
}

/** Pack zones: journaled for the graded policy; not applied under a custom policy. */
function resolvePackZones(options: CreateToolBusOptions): PackZonePlan {
  if (!options.packs) return EMPTY_PACK_ZONES;
  const plan = planPackZones(options.packs);
  if (!options.policy) return journalPackZones(plan, options.journal, options.packs.sessionId);
  const problem = 'a custom permission policy is in force; pack zones are not applied';
  return {
    ...plan,
    relaxed: [],
    refused: [...plan.refused, ...plan.relaxed.map((r) => ({ ...r, problem }))],
  };
}

/** Defaults (principle 5) + `$KPAI_HOME/policy.json` + `policyOptions`, unless a policy is given. */
async function resolvePolicy(
  options: CreateToolBusOptions,
  packZones: PackZonePlan,
): Promise<{ policy: PermissionPolicy; activePolicy?: ActivePolicy; policyError?: string }> {
  if (options.policy) return { policy: options.policy };
  const loaded =
    options.kpaiHome === undefined ? undefined : await loadPolicyConfig(options.kpaiHome);
  const config = loaded?.config ?? { forbiddenPaths: [], denyByModel: {} };
  const policy = buildPolicy(config, { ...options.policyOptions, packZones });
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
