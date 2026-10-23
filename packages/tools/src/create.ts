import path from 'node:path';
import type { PermissionPolicy } from '@kernelpai/core';
import { builtinTools, type BuiltinOptions } from './builtins/index.js';
import { LocalToolBus, type ToolJournal } from './bus.js';
import type { Env } from './env.js';
import { loadMcpConfig, type McpConnectResult } from './mcp.js';
import { connectPinnedServers, type PinnedConnectResult } from './mcp-registry.js';
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
  /**
   * MCP servers that failed to start, a broken mcp.json, and servers blocked by their pin
   * (unapproved or changed: their calls are refused, R-501). The bus still works.
   */
  mcpErrors: McpConnectResult['errors'];
  /** Allow-listed servers whose calls are refused until a person (re-)approves them. */
  mcpBlocked: PinnedConnectResult['blocked'];
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
    tools: builtinTools({
      env,
      git: gitOptions(options, policy),
      shell: options.shell,
      test: options.test,
      browser: browserOptions(options, policy),
    }),
    policy,
    journal: options.journal,
    maxResultBytes: options.maxResultBytes,
    env,
  });
  const { mcpErrors, mcpBlocked } = await attachMcp(bus, options);
  return { bus, mcpErrors, mcpBlocked, ...status, packZones };
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

/**
 * The browser reads `file:` pages under the same zones as the git tools; screenshots go
 * to `$KPAI_HOME/artifacts/browser` when there is a home.
 */
function browserOptions(options: CreateToolBusOptions, policy: PermissionPolicy) {
  const home = options.kpaiHome;
  return {
    ...(home ? { artifactDir: path.join(home, 'artifacts', 'browser') } : {}),
    ...options.browser,
    zones: options.browser?.zones ?? gitOptions(options, policy).zones,
  };
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
): Promise<Pick<CreatedToolBus, 'mcpErrors' | 'mcpBlocked'>> {
  if (options.kpaiHome === undefined) return { mcpErrors: [], mcpBlocked: [] };
  let connected: PinnedConnectResult;
  try {
    const config = await loadMcpConfig(options.kpaiHome);
    connected = await connectPinnedServers(options.kpaiHome, config, {
      ...(options.mcpConnectTimeoutMs ? { timeoutMs: options.mcpConnectTimeoutMs } : {}),
      onEgressDenied: egressJournal(options),
    });
  } catch (err) {
    return { mcpErrors: [{ server: 'mcp.json', message: (err as Error).message }], mcpBlocked: [] };
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
  for (const b of connected.blocked) mcpErrors.push({ server: b.server, message: b.reason });
  return { mcpErrors, mcpBlocked: connected.blocked };
}

/** Refused egress of an MCP server, journaled when the run's session is known. */
function egressJournal(options: CreateToolBusOptions) {
  const sessionId = options.packs?.sessionId;
  const journal = options.journal;
  return (server: string, d: { host: string; port: number }): void => {
    if (!journal || !sessionId) return;
    journal.append({
      sessionId,
      type: 'intervention',
      payload: { action: 'mcp egress refused', server, host: d.host, port: d.port },
    });
  };
}
