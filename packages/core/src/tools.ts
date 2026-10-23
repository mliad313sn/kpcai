import type { ModelRef } from './routing.js';
import type { ToolCall } from './schemas.js';

/** Spec §3.3 graded permissions: read free, write confirmed per batch, destructive one by one. */
export type ToolRisk = 'read' | 'write' | 'destructive';

export interface ToolDefinition {
  /** Namespaced: `fs.read`, `git.diff`, `shell.run`, `mcp.<server>.<tool>`. */
  name: string;
  description: string;
  /** JSON Schema of the input object. */
  inputSchema: Record<string, unknown>;
  risk: ToolRisk;
  /** `builtin` or `mcp:<server>`. */
  source: string;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

export type PermissionDecision = 'allow' | 'confirm' | 'deny';

export interface ToolContext {
  /** Model on whose behalf the call runs (per-model permissions, spec §3.3). */
  model: ModelRef;
  /** Workspace root: tools never act outside it. */
  root: string;
  sessionId: string;
  nodeId: string;
  signal?: AbortSignal;
  /** Asks the human; resolves false when declined or non-interactive. */
  confirm(question: string): Promise<boolean>;
}

export interface PermissionPolicy {
  decide(def: ToolDefinition, call: ToolCall, ctx: ToolContext): PermissionDecision;
  /** "Trust for this session on this folder" (spec §3.3). */
  trust(scope: { sessionId: string; root: string; risk: Exclude<ToolRisk, 'destructive'> }): void;
}

/** The universal tool bus (spec §3.3): built-in tools and MCP servers behind one interface. */
export interface ToolBus {
  list(): readonly ToolDefinition[];
  /** Validates, applies the permission policy, runs, journals. Never throws for tool errors. */
  call(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
  close(): Promise<void>;
}
