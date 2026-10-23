import type { ToolContext } from '@kernelpai/core';
import { resolveInRoot } from '../paths.js';
import type { LocalTool } from '../types.js';
import { gitApplyTool } from './git-apply.js';
import { DEFAULT_FORBIDDEN_PATHS } from '../policy.js';
import { git, outcome, type GitToolOptions } from './git-exec.js';
import { excludePathspecs, filterDiff, filterStatus, type ZoneFilter } from './git-filter.js';

export type { GitApplyRules, GitToolOptions } from './git-exec.js';

/**
 * Pathspecs after `--`: the jailed path taken literally (`:(literal)`, no magic
 * from the model) or `.` (keeps output to a subdirectory root), then one
 * `:(exclude,glob)` per forbidden zone.
 */
async function pathspecs(ctx: ToolContext, p: unknown, zones: ZoneFilter): Promise<string[]> {
  const base = p === undefined ? '.' : `:(literal)${(await resolveInRoot(ctx.root, p)).rel}`;
  return ['--', base, ...excludePathspecs(zones)];
}

function zonesOf(opts: GitToolOptions): ZoneFilter {
  return {
    globs: opts.forbiddenPaths ?? DEFAULT_FORBIDDEN_PATHS,
    caseInsensitive: opts.caseInsensitive ?? process.platform === 'win32',
  };
}

/** `outcome`, with forbidden-zone entries dropped from successful output. */
function shown(r: Awaited<ReturnType<typeof git>>, filter: (out: string) => string) {
  const o = outcome(r);
  return o.isError || r.stdout === '' ? o : { ...o, content: filter(r.stdout) || '(no output)' };
}

const optPath = { type: 'string' } as const;

const LOG_FORMAT = ['--no-ext-diff', '--format=%h %ad %an %s', '--date=short'];

const def = (name: string, description: string, properties: Record<string, unknown>) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, additionalProperties: false },
  risk: 'read' as const,
  source: 'builtin',
});

function readTools(opts: GitToolOptions): LocalTool[] {
  const zones = zonesOf(opts);
  return [
    {
      def: def('git.status', 'Show the working tree status (porcelain, with branch).', {}),
      run: async (_input, ctx) => {
        const spec = await pathspecs(ctx, undefined, zones);
        const args = ['status', '--porcelain=v1', '-b', '--ignore-submodules=all', ...spec];
        return shown(await git(opts, ctx, args), (o) => filterStatus(o, zones));
      },
    },
    {
      def: def('git.diff', 'Show unstaged changes, or staged ones with `staged: true`.', {
        staged: { type: 'boolean' },
        path: optPath,
      }),
      run: async (input, ctx) => {
        const args = [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--ignore-submodules=all',
        ];
        if (input.staged === true) args.push('--cached');
        const spec = await pathspecs(ctx, input.path, zones);
        return shown(await git(opts, ctx, [...args, ...spec]), (o) => filterDiff(o, zones));
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
        return outcome(
          await git(opts, ctx, [...args, ...(await pathspecs(ctx, input.path, zones))]),
        );
      },
    },
  ];
}

export function gitTools(opts: GitToolOptions = {}): LocalTool[] {
  return [...readTools(opts), gitApplyTool(opts)];
}
