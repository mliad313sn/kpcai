/**
 * Control files (D-035, P5-F2/F4): files that decide how KP Studio, an agent or the
 * project's own tests behave. A run that writes one changes the rules it is judged by, so
 * such a write is never pre-answered or batch-approved, and a test run whose configuration
 * the run changed is no test evidence. P5-R2 adds the package-manager, toolchain and
 * lockfiles that pick the runner (`.npmrc`, `.yarnrc.yml`, `pnpm-workspace.yaml`, …).
 * Matching is lexical and case-insensitive.
 */

/** Directories whose every file is control: KP Studio's and Claude Code's settings. */
const CONTROL_DIRS = new Set(['.kpstudio', '.claude']);

/** Files that configure how tests run (or the scripts that run them). */
const TEST_CONFIG_NAMES = new Set([
  'package.json',
  'pytest.ini',
  'conftest.py',
  'pyproject.toml',
  'setup.cfg',
  'tox.ini',
  'noxfile.py',
  'cargo.toml',
  'go.mod',
  'makefile',
  'phpunit.xml',
]);

/** `vitest.config.ts`, `vite.config.mjs`, `jest.config.cjs`, `vitest.workspace.json`, `.mocharc.yml`, … */
const TEST_CONFIG_FILES = [
  /^(vitest|vite|jest|playwright|ava|karma)\.(config|workspace|setup)(\.[\w-]+)?\.[cm]?[jt]sx?$/,
  /^(vitest|jest)\.(config|workspace)\.json$/,
  /^\.mocharc(\.[\w]+)?$/,
  /^\.?(babel|swc)(rc|\.config\.[cm]?[jt]s)$/,
  /\.pth$/,
];

/**
 * P5-R2: package-manager, toolchain and module-resolution files. They decide which runner
 * (and which version, shell or loader) a test command reaches without naming a test file:
 * `.npmrc` `script-shell` / `node-options`, a pnpm hook, a Yarn PnP map, a Node or Python
 * version pin, a Python module that shadows pytest from the working directory.
 */
const RUNNER_CONFIG_NAMES = new Set([
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnpmrc',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
  '.pnpmfile.mjs',
  'bunfig.toml',
  '.nvmrc',
  '.node-version',
  '.tool-versions',
  '.python-version',
  '.pnp.cjs',
  '.pnp.js',
  '.pnp.loader.mjs',
  '.pnp.data.json',
  'go.work',
  'rust-toolchain',
  'rust-toolchain.toml',
  'sitecustomize.py',
  'usercustomize.py',
  'pytest.py',
]);

/** Lockfiles: they change which runner a command resolves to (P5-R2). */
const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'poetry.lock',
  'uv.lock',
  'pipfile.lock',
  'pdm.lock',
]);

/** Directories whose every file configures a toolchain: Yarn (releases, plugins, PnP cache), Cargo (`runner`). */
const TOOL_DIRS = new Set(['.yarn', '.cargo']);
/** A `.py` file under one of these shadows pytest itself (`python -m pytest` imports from the cwd). */
const PY_SHADOW_DIRS = new Set(['pytest', '_pytest']);

/** The repository file naming the test command (also in test-detect.ts). */
const REPO_TEST_JSON = '.kpstudio/test.json';

function segments(rel: string): string[] {
  return rel
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/')
    .filter((s) => s !== '' && s !== '.');
}

/** True for a lockfile (P5-R2): a change to it may change the resolved runner. */
export function isLockfilePath(rel: string): boolean {
  return LOCKFILE_NAMES.has(segments(rel).pop() ?? '');
}

/** True for a file that configures how the project's tests run (P5-F4, P5-R2). */
export function isTestConfigPath(rel: string): boolean {
  const s = segments(rel);
  const name = s[s.length - 1] ?? '';
  const dirs = s.slice(0, -1);
  if (s.join('/').endsWith(REPO_TEST_JSON)) return true;
  if (dirs.some((d) => TOOL_DIRS.has(d))) return true;
  if (name.endsWith('.py') && dirs.some((d) => PY_SHADOW_DIRS.has(d))) return true;
  if (RUNNER_CONFIG_NAMES.has(name) || LOCKFILE_NAMES.has(name)) return true;
  return TEST_CONFIG_NAMES.has(name) || TEST_CONFIG_FILES.some((re) => re.test(name));
}

/**
 * True for a control file (P5-F2): anything under `.kpstudio/` or `.claude/`, `.mcp.json`,
 * and every test configuration file (package.json included: its scripts run on install
 * and test).
 */
export function isControlPath(rel: string): boolean {
  const s = segments(rel);
  if (s.slice(0, -1).some((d) => CONTROL_DIRS.has(d))) return true;
  return s[s.length - 1] === '.mcp.json' || isTestConfigPath(rel);
}

function unquote(p: string): string {
  const t = p.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/**
 * Every path a unified or git diff names (headers, renames, copies), lexically. A patch
 * git would apply always has such headers; one without them names nothing.
 */
export function patchPaths(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split('\n')) {
    const git = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
    if (git) {
      out.add(git[1] as string);
      out.add(git[2] as string);
      continue;
    }
    const head = /^(?:---|\+\+\+) (.+)$/.exec(line);
    if (head) {
      const p = unquote((head[1] as string).split('\t')[0] as string);
      if (p !== '/dev/null') out.add(p.replace(/^[ab]\//, ''));
      continue;
    }
    const move = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (move) out.add(unquote(move[1] as string));
  }
  return [...out];
}

/** Builtin tools that write files, and where their input names the paths. */
const WRITERS: Readonly<Record<string, (input: Record<string, unknown>) => string[]>> = {
  'fs.write': (i) => (typeof i.path === 'string' ? [i.path] : []),
  'fs.delete': (i) => (typeof i.path === 'string' ? [i.path] : []),
  'git.apply': (i) => (typeof i.patch === 'string' ? patchPaths(i.patch) : []),
};

/** True when a builtin write tool's call would write a control file. */
export function writesControl(tool: string, input: unknown): boolean {
  const paths = WRITERS[tool];
  if (!paths || input === null || typeof input !== 'object') return false;
  return paths(input as Record<string, unknown>).some(isControlPath);
}
