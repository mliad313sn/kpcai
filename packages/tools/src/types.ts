import type { ToolContext, ToolDefinition, ToolResult, ToolRisk } from '@kernelpai/core';

/** What a tool run returns: the result plus journal-safe metadata (never contents). */
export interface ToolOutcome extends ToolResult {
  meta?: Record<string, unknown>;
}

/** What the human is shown before confirming a call (already sanitised by the bus). */
export interface PreparedCall {
  /** Paths, sizes, files touched: one or two lines. */
  summary: string;
  /** Optional content preview (at most 20 lines). */
  preview?: string;
}

/** A tool implementation registered on the {@link LocalToolBus}. */
export interface LocalTool {
  readonly def: ToolDefinition;
  /** Risk of this particular call when it depends on the input (e.g. `shell.run`). */
  riskFor?(input: Record<string, unknown>): ToolRisk;
  /** True when this call must be confirmed whatever the policy says (unsandboxed shell). */
  alwaysConfirm?(input: Record<string, unknown>): boolean;
  /**
   * Validates the call against the workspace and describes it for the confirmation
   * question. Runs only when the human will be asked, before asking; a throw
   * refuses the call without asking.
   */
  prepare?(input: Record<string, unknown>, ctx: ToolContext): Promise<PreparedCall>;
  /** Runs an already validated and permitted call. May throw; the bus turns it into isError. */
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
  /** Releases resources (MCP connections). */
  close?(): Promise<void>;
}

/** Thrown by tools for an expected, model-facing failure (bad path, refused patch...). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function ok(content: string, meta?: Record<string, unknown>): ToolOutcome {
  return meta ? { content, isError: false, meta } : { content, isError: false };
}

export function fail(content: string, meta?: Record<string, unknown>): ToolOutcome {
  return meta ? { content, isError: true, meta } : { content, isError: true };
}
