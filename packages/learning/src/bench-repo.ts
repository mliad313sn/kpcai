/**
 * Picks the source files a bench may use (spec §4.6, ADR-0028): small source files of the
 * current repository, never in a forbidden zone (the kernel's `allowed` predicate), never
 * a secret-looking file, never generated or vendored code. Deterministic: the same tree
 * gives the same files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
]);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  '__pycache__',
  'venv',
]);
const SECRETISH = /(^|[/\\])(\.env|secrets?|credentials?|.*\.(pem|key|p12|pfx))([/\\.]|$)/i;
const TESTISH =
  /(^|[/\\])(tests?|__tests__|spec)[/\\]|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|[/\\])test_[^/\\]*\.py$/i;

export interface RepoScanOptions {
  root: string;
  /** The kernel's zone check on a root-relative path ('/' separators): false = never read. */
  allowed: (rel: string) => boolean;
  /** Files visited at most. Default 5,000. */
  maxEntries?: number;
  minBytes?: number;
  maxBytes?: number;
}

export interface SourceFile {
  /** Root-relative, '/' separators. */
  rel: string;
  text: string;
  /** Named top-level functions, in file order. */
  functions: string[];
  /** Named top-level symbols (functions, classes, types), in file order. */
  symbols: string[];
}

const FUNCTION_PATTERNS: Record<string, RegExp[]> = {
  js: [
    /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
    /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm,
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  ],
  py: [/^def\s+([A-Za-z]\w*)\s*\(/gm],
  go: [/^func\s+([A-Za-z]\w*)\s*\(/gm],
  rs: [/^pub\s+(?:async\s+)?fn\s+([A-Za-z]\w*)/gm],
};
const TYPE_PATTERNS: Record<string, RegExp[]> = {
  js: [
    /^export\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  ],
  py: [/^class\s+([A-Za-z]\w*)/gm],
  go: [/^type\s+([A-Za-z]\w*)\s/gm],
  rs: [/^pub\s+(?:struct|enum|trait)\s+([A-Za-z]\w*)/gm],
};

function lang(rel: string): string {
  const ext = extname(rel);
  if (ext === '.py') return 'py';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rs';
  return 'js';
}

function names(text: string, patterns: readonly RegExp[]): Array<{ name: string; at: number }> {
  const out: Array<{ name: string; at: number }> = [];
  for (const p of patterns) {
    for (const m of text.matchAll(p)) if (m[1]) out.push({ name: m[1], at: m.index ?? 0 });
  }
  return out;
}

/** Named functions and symbols of a source file, in order, without duplicates. */
export function symbolsOf(rel: string, text: string): { functions: string[]; symbols: string[] } {
  const l = lang(rel);
  const fns = names(text, FUNCTION_PATTERNS[l] ?? []).sort((a, b) => a.at - b.at);
  const all = [...fns, ...names(text, TYPE_PATTERNS[l] ?? [])].sort((a, b) => a.at - b.at);
  const uniq = (xs: Array<{ name: string }>): string[] => [...new Set(xs.map((x) => x.name))];
  return { functions: uniq(fns), symbols: uniq(all) };
}

/** True when a path is never offered to a bench, whatever the zones say. */
export function excludedPath(rel: string): boolean {
  return SECRETISH.test(rel) || TESTISH.test(rel);
}

function walk(o: RepoScanOptions, dir: string, files: string[], budget: { left: number }): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    if (budget.left-- <= 0) return;
    if (name.startsWith('.')) continue;
    const abs = join(dir, name);
    const rel = relative(o.root, abs).split(sep).join('/');
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name) && o.allowed(rel)) walk(o, abs, files, budget);
    } else if (st.isFile() && SOURCE_EXTENSIONS.has(extname(name))) {
      const size = st.size;
      if (size >= (o.minBytes ?? 200) && size <= (o.maxBytes ?? 8_000)) files.push(rel);
    }
  }
}

/** Source files the bench may use, sorted by path. */
export function scanSources(o: RepoScanOptions): SourceFile[] {
  const rels: string[] = [];
  walk(o, o.root, rels, { left: o.maxEntries ?? 5_000 });
  const out: SourceFile[] = [];
  for (const rel of rels) {
    if (excludedPath(rel) || !o.allowed(rel)) continue;
    let text: string;
    try {
      text = readFileSync(join(o.root, rel), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    out.push({ rel, text, ...symbolsOf(rel, text) });
  }
  return out;
}
