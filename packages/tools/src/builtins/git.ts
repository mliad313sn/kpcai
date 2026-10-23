import type { ToolContext } from '@kernelpai/core';
import { resolveInRoot } from '../paths.js';
import type { LocalTool } from '../types.js';
import { gitApplyTool } from './git-apply.js';
import { git, outcome, type GitToolOptions } from './git-exec.js';

export type { GitApplyRules, GitToolOptions } from './git-exec.js';

/** Jails optional pathspecs; returns them root-relative, after a `--`. */
async function pathspecs(ctx: ToolContext, p: unknown): Promise<string[]> {
  // Default `.` keeps output to the root when the root is a repo subdirectory.
  if (p === undefined) return ['--', '.'];
  const j = await resolveInRoot(ctx.root, p);
  return ['--', j.rel];
}

const optPath = { type: 'string' } as const;

const LOG_FORMAT = ['--no-ext-diff', '--format=%h %ad %an %s', '--date=short'];

function readTools(opts: GitToolOptions): LocalTool[] {
  const def = (name: string, description: string, properties: Record<string, unknown>) => ({
    name,
    description,
    inputSchema: { type: 'object', properties, additionalProperties: false },
    risk: 'read' as const,
    source: 'builtin',
  });
  return [
    {
      def: def('git.status', 'Show the working tree status (porcelain, with branch).', {}),
      run: async (_input, ctx) => {
        const spec = await pathspecs(ctx, undefined);
        return outcome(await git(opts, ctx, ['status', '--porcelain=v1', '-b', ...spec]));
      },
    },
    {
      def: def('git.diff', 'Show unstaged changes, or staged ones with `staged: true`.', {
        staged: { type: 'boolean' },
        path: optPath,
      }),
      run: async (input, ctx) => {
        const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
        if (input.staged === true) args.push('--cached');
        return outcome(await git(opts, ctx, [...args, ...(await pathspecs(ctx, input.path))]));
      },
    },
    {
      def: def('git.log', 'Show recent commits (one line each, at most 100).', {
        maxCount: { type: 'integer', minimum: 1, maximum: 100 },
        path: optPath,
      }),
      run: async (input, ctx) => {
        const n = typeof input.maxCount === 'number' ? input.maxCount : 20;
        const args = ['log', '--no-color', `--max-count=${n}`, ...LOG_FORMAT];
        return outcome(await git(opts, ctx, [...args, ...(await pathspecs(ctx, input.path))]));
      },
    },
  ];
}

export function gitTools(opts: GitToolOptions = {}): LocalTool[] {
  return [...readTools(opts), gitApplyTool(opts)];
}
