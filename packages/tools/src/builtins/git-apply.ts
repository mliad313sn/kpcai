import { realpath } from 'node:fs/promises';
import type { ToolContext } from '@kernelpai/core';
import { checkLexical, resolveInRoot, touchesGitDir } from '../paths.js';
import { DEFAULT_ZONES, defaultCaseInsensitive, zoneHit, zoneSetFromGlobs } from '../zones.js';
import { previewLines, stripControls } from '../text.js';
import { ok, ToolError, type LocalTool, type ToolOutcome } from '../types.js';
import { failed, git, outcome, type GitToolOptions } from './git-exec.js';
import { assertPrintable, checkSections, parseNumstat, parsePatch, summaryModes } from './patch.js';

interface Location {
  cwd?: string;
  /** `--directory=<prefix>` when the root is a repository subdirectory. */
  args: string[];
  prefix: string;
}

/**
 * Where to run `git apply` so patch paths are root-relative in every case. From a
 * repo subdirectory git resolves `diff --git` patches against the top level and
 * silently skips paths outside the cwd, while plain patches are cwd-relative. So
 * when the root is a subdirectory we run from the top level with
 * `--directory=<prefix>`: both formats then land under the root, and the user's
 * repository config (e.g. core.autocrlf) still applies.
 */
async function applyLocation(opts: GitToolOptions, ctx: ToolContext): Promise<Location> {
  const r = await git(opts, ctx, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (r.code !== 0) return { args: [], prefix: '' };
  const [top = '', prefix = ''] = r.stdout.split(/\r?\n/);
  if (prefix === '' || top === '') return { args: [], prefix: '' };
  return { cwd: await realpath(top), args: [`--directory=${prefix}`], prefix };
}

async function gitApply(
  opts: GitToolOptions,
  ctx: ToolContext,
  at: Location,
  args: string[],
  patch: string,
) {
  return git(opts, ctx, ['apply', ...args, ...at.args, '-'], patch, at.cwd);
}

function gitError(stage: string, r: Awaited<ReturnType<typeof git>>): ToolError {
  const o = outcome(r);
  return new ToolError(`git apply ${stage} failed: ${stripControls(o.content).slice(0, 2000)}`);
}

/** Paths git itself would touch, made root-relative (prefix stripped). */
async function gitTargets(opts: GitToolOptions, ctx: ToolContext, at: Location, patch: string) {
  const num = await gitApply(opts, ctx, at, ['--numstat', '-z'], patch);
  if (failed(num)) throw gitError('--numstat', num);
  const sum = await gitApply(opts, ctx, at, ['--summary'], patch);
  if (failed(sum)) throw gitError('--summary', sum);
  const { paths, binary } = parseNumstat(num.stdout);
  const rel = (p: string): string => {
    if (!p.startsWith(at.prefix))
      throw new ToolError(`patch touches a path outside the root: ${p}`);
    return p.slice(at.prefix.length);
  };
  return { paths: paths.map(rel), binary: binary.map(rel), modes: summaryModes(sum.stdout) };
}

export interface InspectedPatch {
  files: string[];
  at: Location;
}

/**
 * Every check short of applying: printable text, section rules, targets from the
 * headers and from `git apply --numstat --summary`, each jailed, then `--check`.
 */
export async function inspectPatch(
  opts: GitToolOptions,
  ctx: ToolContext,
  patch: string,
): Promise<InspectedPatch> {
  assertPrintable(patch);
  const sections = parsePatch(patch);
  const rules = opts.apply ?? {};
  checkSections(sections, rules);
  const at = await applyLocation(opts, ctx);
  const fromGit = await gitTargets(opts, ctx, at, patch);
  if (fromGit.binary.length > 0 && !rules.allowBinary) {
    throw new ToolError(`binary patch refused: ${fromGit.binary.join(', ')}`);
  }
  if (fromGit.modes.includes('120000') && !rules.allowSymlinks) {
    throw new ToolError('patches that create or change symlinks are refused');
  }
  if (fromGit.modes.includes('100755') && !rules.allowExecutable) {
    throw new ToolError('patches that create or make files executable are refused');
  }
  const files = [...new Set([...sections.flatMap((s) => s.paths), ...fromGit.paths])].sort();
  // The policy reads paths from the patch text; git's own list is the authority (WP7-F4:
  // `+++ b/x y/.env` or `copy to .env` named a zone the header parse did not see).
  const zones =
    opts.zones ??
    zoneSetFromGlobs(
      opts.forbiddenPaths ?? DEFAULT_ZONES,
      opts.caseInsensitive ?? defaultCaseInsensitive(),
    );
  for (const f of files) {
    checkLexical(f);
    const j = await resolveInRoot(ctx.root, f, { noFinalSymlink: true });
    if (touchesGitDir(j.rel)) throw new ToolError(`patch may not touch .git: ${f}`);
    if (zoneHit(j.rel, zones) ?? zoneHit(f, zones))
      throw new ToolError(`patch touches a forbidden zone: ${f}`);
  }
  const check = await gitApply(opts, ctx, at, ['--check'], patch);
  if (failed(check)) throw gitError('--check', check);
  return { files, at };
}

export function gitApplyTool(opts: GitToolOptions): LocalTool {
  return {
    def: {
      name: 'git.apply',
      description:
        'Apply a unified diff (with a/ and b/ prefixes, text hunks only) to the workspace. Validated and checked with `git apply --check` first; binary, executable and symlink changes are refused.',
      inputSchema: {
        type: 'object',
        properties: { patch: { type: 'string', minLength: 1 } },
        required: ['patch'],
        additionalProperties: false,
      },
      risk: 'write',
      source: 'builtin',
    },
    async prepare(input, ctx) {
      const patch = String(input.patch);
      const { files } = await inspectPatch(opts, ctx, patch);
      const bytes = Buffer.byteLength(patch, 'utf8');
      return {
        summary: `files (${files.length}): ${files.join(', ')}; patch ${bytes} bytes`,
        preview: previewLines(patch),
      };
    },
    async run(input, ctx): Promise<ToolOutcome> {
      const patch = String(input.patch);
      // Re-inspected: the tree may have changed while the human was reading.
      const { files, at } = await inspectPatch(opts, ctx, patch);
      const meta = { files, bytes: Buffer.byteLength(patch, 'utf8') };
      const applied = await gitApply(opts, ctx, at, [], patch);
      if (applied.code !== 0) return outcome(applied, { ...meta, stage: 'apply' });
      return ok(`applied patch to ${files.length} file(s): ${files.join(', ')}`, meta);
    },
  };
}
