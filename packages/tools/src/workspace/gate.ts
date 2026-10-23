import type { PermissionPolicy, ToolContext, ToolDefinition } from '@kernelpai/core';
import { isConfirmAware } from '../policy.js';
import { stripControls } from '../text.js';
import { ToolError } from '../types.js';

/**
 * How a workspace action that changes the user's tree is authorised: the same
 * permission policy as the tool bus, and the human's confirm() from the context.
 * The context's root is replaced by the workspace root the action works on.
 */
export interface Gate {
  policy: PermissionPolicy;
  ctx: ToolContext;
}

const def = (name: string, risk: ToolDefinition['risk'], description: string): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object' },
  risk,
  source: 'builtin',
});

/** Restoring a checkpoint overwrites and deletes files: confirmed every time. */
export const RESTORE_DEF = def(
  'checkpoint.restore',
  'destructive',
  'Restore the workspace to a checkpoint (overwrites and deletes files).',
);

/** Merging a run back writes the user's tree through the git.apply checks. */
export const MERGE_DEF = def(
  'worktree.merge',
  'write',
  "Apply a run's diff from its worktree to the workspace (never commits).",
);

/**
 * Asks the policy, then (when it says `confirm`) the human. Throws a ToolError
 * on deny or decline. `input` is what the policy inspects (paths, patch).
 */
export async function authorize(
  gate: Gate,
  root: string,
  tool: ToolDefinition,
  input: Record<string, unknown>,
  summary: string,
): Promise<void> {
  const ctx: ToolContext = { ...gate.ctx, root };
  const call = { id: `${tool.name}-${Date.now()}`, name: tool.name, input };
  const decision = gate.policy.decide(tool, call, ctx);
  if (decision === 'deny') {
    const why = isConfirmAware(gate.policy) ? gate.policy.reason?.(tool, call, ctx) : undefined;
    throw new ToolError(`permission deny: ${why ?? `${tool.name} is not permitted`}`);
  }
  if (decision === 'allow') return;
  const question = stripControls(`${tool.name} (${tool.risk}) on ${root}\n${summary}`);
  const yes = await ctx.confirm(question).catch(() => false);
  if (!yes) throw new ToolError('permission declined: declined by the user');
  if (isConfirmAware(gate.policy)) gate.policy.confirmed(tool, call, ctx);
}
