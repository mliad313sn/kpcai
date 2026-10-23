/**
 * Which test command runs a project (R-505): the configured one, else one detected from
 * the project's files. Detection reads files only; it never runs anything.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ToolError } from '../types.js';
import type { ParserName } from './test-parse.js';

export type RunnerKind = ParserName | 'cargo' | 'script' | 'configured';

export interface TestCommand {
  kind: RunnerKind;
  command: string;
  args: string[];
  /** Where the command came from, shown in the confirmation question. */
  origin: string;
}

export const TestCommandConfigSchema = z.object({
  command: z.string().min(1).max(256),
  args: z.array(z.string().max(4096)).max(64).default([]),
});
export type TestCommandConfig = z.infer<typeof TestCommandConfigSchema>;

/** Repository file naming the project's test command (`{ "command": "pnpm", "args": ["test"] }`). */
export const REPO_TEST_CONFIG = '.kpstudio/test.json';

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

async function readJson(p: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ToolError(`cannot read ${path.basename(p)}: ${(err as Error).message.slice(0, 200)}`);
  }
}

async function packageManager(root: string): Promise<string> {
  if (await exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(root, 'yarn.lock'))) return 'yarn';
  if (await exists(path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

const NPM_DEFAULT_TEST = /no test specified/;

async function fromPackageJson(root: string): Promise<TestCommand | undefined> {
  const pkg = (await readJson(path.join(root, 'package.json'))) as
    { dependencies?: object; devDependencies?: object; scripts?: { test?: unknown } } | undefined;
  if (!pkg || typeof pkg !== 'object') return undefined;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const origin = 'detected from package.json';
  if ('vitest' in deps) return { kind: 'vitest', command: 'npx', args: ['vitest', 'run'], origin };
  if ('jest' in deps) return { kind: 'jest', command: 'npx', args: ['jest', '--ci'], origin };
  const script = pkg.scripts?.test;
  if (typeof script === 'string' && !NPM_DEFAULT_TEST.test(script)) {
    return { kind: 'script', command: await packageManager(root), args: ['test'], origin };
  }
  return undefined;
}

const PYTEST_MARKERS = ['pytest.ini', 'conftest.py', 'pyproject.toml', 'setup.cfg', 'tox.ini'];

async function fromOtherMarkers(root: string, platform: NodeJS.Platform) {
  for (const m of PYTEST_MARKERS) {
    if (await exists(path.join(root, m))) {
      const python = platform === 'win32' ? 'python' : 'python3';
      return {
        kind: 'pytest',
        command: python,
        args: ['-m', 'pytest'],
        origin: `detected from ${m}`,
      } as const;
    }
  }
  if (await exists(path.join(root, 'go.mod'))) {
    return {
      kind: 'go',
      command: 'go',
      args: ['test', '-json', './...'],
      origin: 'detected from go.mod',
    } as const;
  }
  if (await exists(path.join(root, 'Cargo.toml'))) {
    return {
      kind: 'cargo',
      command: 'cargo',
      args: ['test'],
      origin: 'detected from Cargo.toml',
    } as const;
  }
  return undefined;
}

/**
 * The test command for `root`: the caller's configuration, then `.kpstudio/test.json`,
 * then package.json (vitest, jest, a `test` script), pytest markers, go.mod, Cargo.toml.
 */
export async function resolveTestCommand(
  root: string,
  configured?: TestCommandConfig,
  platform: NodeJS.Platform = process.platform,
): Promise<TestCommand> {
  if (configured) return { kind: 'configured', ...configured, origin: 'configured' };
  const repo = await readJson(path.join(root, REPO_TEST_CONFIG));
  if (repo !== undefined) {
    const parsed = TestCommandConfigSchema.safeParse(repo);
    if (!parsed.success)
      throw new ToolError(
        `${REPO_TEST_CONFIG} is invalid: ${parsed.error.issues[0]?.message ?? ''}`,
      );
    return { kind: 'configured', ...parsed.data, origin: REPO_TEST_CONFIG };
  }
  const found = (await fromPackageJson(root)) ?? (await fromOtherMarkers(root, platform));
  if (found) return { ...found, args: [...found.args] };
  throw new ToolError(
    `no test runner detected in the workspace; add ${REPO_TEST_CONFIG} ({"command": "...", "args": [...]})`,
  );
}

/** Adds the model's filter and files in the runner's own syntax; refused where it has none. */
export function withSelection(cmd: TestCommand, filter?: string, files: string[] = []): string[] {
  const args = [...cmd.args];
  if (filter === undefined && files.length === 0) return args;
  switch (cmd.kind) {
    case 'vitest':
    case 'jest':
      return [...args, ...(filter !== undefined ? ['-t', filter] : []), '--', ...files];
    case 'pytest':
      return [...args, ...(filter !== undefined ? ['-k', filter] : []), '--', ...files];
    case 'go':
      if (files.length > 0) throw new ToolError('go test takes packages, not files: use filter');
      return [...args, '-run', filter as string];
    default:
      throw new ToolError(`filter and files are not supported for a ${cmd.kind} test command`);
  }
}
