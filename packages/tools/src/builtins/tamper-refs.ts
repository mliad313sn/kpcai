/**
 * P5-R2: the runner side of a test command. The line (ADR-0032 addendum, NORTH-STAR):
 * test files and the code under test are the work and may change freely; anything that
 * decides how tests run or what counts as a pass is the runner side, and a run that
 * changes it earns no test evidence. The runner side is, in the tree as it will run:
 *  - files the test command, `.kpstudio/test.json` or the root package.json test scripts
 *    name (`node scripts/run.js`);
 *  - files a test configuration names by path (vitest / jest `setupFiles`, `globalSetup`,
 *    reporters, environments, a custom runner, an `.npmrc` `script-shell` or `--require`);
 *  - everything those files import, require or name in turn, followed transitively (a
 *    runner script that requires `lib/runner.js` puts it on the runner side).
 * Test files are never runner side, and the walk does not go through them, so a runner
 * that loads the test files does not drag the code under test along. Lexical: specifiers
 * and path-like words, resolved with Node's extension and index rules. Reads files only.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isLockfilePath, isTestConfigPath } from '../control-files.js';
import type { TestCommand } from './test-detect.js';

export interface RunnerSide {
  /** Existing runner-side files, relative to the root (posix). */
  files: Set<string>;
  /** Spellings a runner-side reference names that do not exist (a deleted runner file). */
  missing: Set<string>;
  /** More runner-side files than the walk follows: the rest is unverified. */
  overflow: boolean;
}

export const MAX_RUNNER_SIDE = 400;
const MAX_READ = 512 * 1024;
const MAX_CONFIGS = 100;
const JS_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.json'];
const PATHISH = /[\\/]|\.(?:[cm]?[jt]sx?|sh|py|bash|ps1|rb|pl|json)$/i;
const SPECIFIER =
  /(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)(['"`])([^'"`\n]{1,300})\1/g;
const QUOTED = /(['"`])([^'"`\n\s]{1,300})\1/g;
const PY_IMPORT = /^\s*(?:from\s+(\.*[\w.]*)\s+import\b|import\s+([\w.]+))/gm;
const TEST_FILE = [/\.(?:test|spec)\.[cm]?[jt]sx?$/i, /^test_[^/]*\.py$/i, /_test\.(?:py|go)$/i];
/** npm runs these around `test`; the test command may also run any script by name. */
const TEST_SCRIPTS = ['pretest', 'test', 'posttest'];
/** package.json fields that configure a runner. */
const RUNNER_FIELDS = ['jest', 'ava', 'mocha', 'nyc', 'c8'];

/** A test file: changes to it are the work, never the runner side. */
export function isTestFile(rel: string): boolean {
  const s = rel.split('/');
  const name = s[s.length - 1] ?? '';
  return s.slice(0, -1).includes('__tests__') || TEST_FILE.some((re) => re.test(name));
}

const isFile = (abs: string): Promise<boolean> =>
  stat(abs).then(
    (s) => s.isFile(),
    () => false,
  );

interface Ref {
  /** The spelling, relative to `base` (a directory relative to the root). */
  spec: string;
  bases: string[];
  /** Node's extension and directory-index rules (import specifiers). */
  index: boolean;
}

/** A spelling as the root sees it: `<rootDir>/` dropped, an absolute path inside the root made relative. */
function spelling(root: string, spec: string): { spec: string; absolute: boolean } {
  const s = spec.replace(/^<rootDir>[\\/]/, '');
  if (!path.isAbsolute(s)) return { spec: s.replace(/\\/g, '/'), absolute: false };
  return { spec: path.relative(root, s).split(path.sep).join('/'), absolute: true };
}

function candidates(root: string, ref: Ref): string[] {
  const out: string[] = [];
  const { spec, absolute } = spelling(root, ref.spec);
  for (const base of absolute ? ['.'] : ref.bases) {
    const p = path.posix.normalize(path.posix.join(base, spec));
    if (p.startsWith('..') || path.posix.isAbsolute(p) || p === '.') continue;
    out.push(p, ...JS_EXTS.map((e) => p + e));
    if (/\.[cm]?js$/.test(p)) out.push(p.replace(/js$/, 'ts'));
    if (ref.index) out.push(...JS_EXTS.map((e) => `${p}/index${e}`));
  }
  return [...new Set(out.map((c) => c.replace(/^\.\//, '')))];
}

class Walk {
  readonly side: RunnerSide = { files: new Set(), missing: new Set(), overflow: false };
  private queue: string[] = [];

  constructor(private readonly root: string) {}

  async add(ref: Ref): Promise<void> {
    const list = candidates(this.root, ref);
    for (const c of list) {
      if (!(await isFile(path.join(this.root, c)))) continue;
      if (isTestFile(c) || this.side.files.has(c)) return;
      if (this.side.files.size >= MAX_RUNNER_SIDE) {
        this.side.overflow = true;
        return;
      }
      this.side.files.add(c);
      this.queue.push(c);
      return;
    }
    // A missing file still names a spelling: a run that deleted it changed the runner.
    for (const c of list.slice(0, 1)) if (!isTestFile(c)) this.side.missing.add(c);
  }

  async words(text: string, bases: string[]): Promise<void> {
    for (const w of text.split(/[\s;&|()<>"'`=,[\]{}]+/)) {
      if (w !== '' && PATHISH.test(w) && !/^\w+:\/\//.test(w))
        await this.add({ spec: w, bases, index: false });
    }
  }

  async source(rel: string, text: string): Promise<void> {
    const dir = path.posix.dirname(rel);
    for (const m of text.matchAll(SPECIFIER)) {
      const spec = m[2] as string;
      if (spec.startsWith('.')) await this.add({ spec, bases: [dir], index: true });
    }
    for (const m of text.matchAll(QUOTED)) {
      const spec = m[2] as string;
      if (PATHISH.test(spec)) await this.add({ spec, bases: [dir, '.'], index: false });
    }
    if (rel.endsWith('.py')) await this.python(text, dir);
    if (!/\.[cm]?[jt]sx?$|\.json$/i.test(rel)) await this.words(text, [dir, '.']);
  }

  private async python(text: string, dir: string): Promise<void> {
    for (const m of text.matchAll(PY_IMPORT)) {
      const mod = (m[1] ?? m[2] ?? '') as string;
      const dots = /^\.*/.exec(mod)?.[0].length ?? 0;
      const name = mod.slice(dots).replace(/\./g, '/');
      const up = dots > 1 ? '../'.repeat(dots - 1) : '';
      const bases = dots > 0 ? [path.posix.join(dir, up)] : [dir, '.'];
      for (const spec of name === '' ? [] : [`${name}.py`, `${name}/__init__.py`])
        await this.add({ spec, bases, index: false });
    }
  }

  async drain(): Promise<void> {
    for (let rel = this.queue.shift(); rel !== undefined; rel = this.queue.shift()) {
      const text = await readText(path.join(this.root, rel));
      if (text !== undefined) await this.source(rel, text);
    }
  }
}

async function readText(abs: string): Promise<string | undefined> {
  const buf = await readFile(abs).catch(() => undefined);
  if (!buf || buf.subarray(0, 8192).includes(0)) return undefined;
  return buf.subarray(0, MAX_READ).toString('utf8');
}

/** Script names a test run reaches: pre/post/test and every script they name, transitively. */
function testScripts(scripts: Record<string, unknown>, cmd: TestCommand | undefined): string[] {
  const seen = new Set<string>();
  const todo = [...TEST_SCRIPTS, ...(cmd ? cmd.args : [])];
  for (let name = todo.pop(); name !== undefined; name = todo.pop()) {
    const body = scripts[name];
    if (seen.has(name) || typeof body !== 'string') continue;
    seen.add(name);
    for (const w of body.split(/[\s;&|()<>"'`=]+/)) {
      todo.push(w, `pre${w}`, `post${w}`);
      if (w.includes(':')) todo.push(w.split(':')[0] as string);
    }
  }
  return [...seen].map((n) => scripts[n] as string);
}

async function packageSeeds(w: Walk, root: string, cmd: TestCommand | undefined): Promise<void> {
  const text = await readText(path.join(root, 'package.json'));
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text ?? '{}') as Record<string, unknown>;
  } catch {
    return; // An unreadable package.json is compared as such by the caller.
  }
  if (pkg === null || typeof pkg !== 'object') return;
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  for (const s of testScripts(scripts as Record<string, unknown>, cmd)) await w.words(s, ['.']);
  for (const f of RUNNER_FIELDS)
    if (pkg[f] !== undefined) await w.source('package.json', JSON.stringify(pkg[f]));
}

/** Sections of an INI / TOML file that configure pytest, tox, nox or coverage. */
function testSections(rel: string, text: string): string {
  if (/(?:^|\/)pytest\.ini$/i.test(rel)) return text;
  const keep: string[] = [];
  let on = false;
  for (const line of text.split('\n')) {
    const head = /^\s*\[+([^\]]+)\]/.exec(line);
    if (head) on = /pytest|testenv|tox|nox|coverage/i.test(head[1] as string);
    else if (on) keep.push(line);
  }
  return keep.join('\n');
}

async function configSeeds(w: Walk, root: string, configs: readonly string[]): Promise<void> {
  for (const rel of configs.slice(0, MAX_CONFIGS)) {
    const name = path.posix.basename(rel).toLowerCase();
    if (name === 'package.json' || name === 'conftest.py' || isLockfilePath(rel)) continue;
    const text = await readText(path.join(root, rel));
    if (text === undefined) continue;
    const dir = path.posix.dirname(rel);
    if (/\.(?:ini|toml|cfg)$/.test(name)) {
      const t = testSections(rel, text);
      await w.words(t, [dir, '.']);
      for (const m of t.matchAll(/-p\s*([\w.]+)/g))
        await w.add({
          spec: `${(m[1] as string).replace(/\./g, '/')}.py`,
          bases: ['.'],
          index: false,
        });
    } else await w.source(rel, text);
  }
}

/**
 * The runner side of `cmd` in `root` (see the module comment). `configs` are the test
 * configuration files in the tree (tracked or not), relative to the root.
 */
export async function runnerSide(
  root: string,
  cmd: TestCommand | undefined,
  configs: readonly string[],
): Promise<RunnerSide> {
  const w = new Walk(root);
  if (cmd) await w.words([cmd.command, ...cmd.args].join(' '), ['.']);
  await packageSeeds(w, root, cmd);
  await configSeeds(w, root, configs.filter(isTestConfigPath));
  await w.drain();
  return w.side;
}
