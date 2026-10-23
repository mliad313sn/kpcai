/**
 * Reads test runner output into counts and failing test names (R-505): vitest, jest,
 * pytest and `go test` (JSON or text), with an exit-code fallback. Output is untrusted
 * text: only counts and short names are kept, never acted on.
 */
import {
  MAX_FAILING,
  type TestCounts,
  type TestEvidence,
  type TestStatus,
} from '../test-evidence.js';

export type ParserName = 'vitest' | 'jest' | 'pytest' | 'go';

interface Parsed extends TestCounts {
  runner: ParserName;
  failing: string[];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

const countOf = (text: string, word: string): number | null => {
  const m = new RegExp(`(\\d+) ${word}`).exec(text);
  return m ? Number(m[1]) : null;
};

function uniq(names: string[]): string[] {
  return [...new Set(names.map((s) => s.trim()).filter(Boolean))].slice(0, MAX_FAILING);
}

function parseVitest(out: string): Parsed | undefined {
  const line = /^\s*Tests\s{2,}(.+\(\d+\))\s*$/m.exec(out)?.[1];
  if (!line) return undefined;
  const failing = [...out.matchAll(/^\s*FAIL\s+(\S.*? > .+?)\s*$/gm)].map((m) => m[1] as string);
  return {
    runner: 'vitest',
    passed: countOf(line, 'passed') ?? 0,
    failed: countOf(line, 'failed') ?? 0,
    skipped: (countOf(line, 'skipped') ?? 0) + (countOf(line, 'todo') ?? 0),
    failing: uniq(failing),
  };
}

function parseJest(out: string): Parsed | undefined {
  const line = /^Tests:\s+(.+ total)\s*$/m.exec(out)?.[1];
  if (!line) return undefined;
  const failing = [...out.matchAll(/^\s*●\s+(.+›.+?)\s*$/gm)].map((m) => m[1] as string);
  return {
    runner: 'jest',
    passed: countOf(line, 'passed') ?? 0,
    failed: countOf(line, 'failed') ?? 0,
    skipped: (countOf(line, 'skipped') ?? 0) + (countOf(line, 'todo') ?? 0),
    failing: uniq(failing),
  };
}

function parsePytest(out: string): Parsed | undefined {
  const lines = [...out.matchAll(/^=+ (.*\bin [\d.]+s.*?) =+\s*$/gm)];
  const line = lines.at(-1)?.[1];
  if (!line) return undefined;
  const failing = [...out.matchAll(/^(?:FAILED|ERROR) (\S+)/gm)].map((m) => m[1] as string);
  return {
    runner: 'pytest',
    passed: countOf(line, 'passed') ?? 0,
    failed: (countOf(line, 'failed') ?? 0) + (countOf(line, 'errors?') ?? 0),
    skipped: (countOf(line, 'skipped') ?? 0) + (countOf(line, 'xfailed') ?? 0),
    failing: uniq(failing),
  };
}

interface GoEvent {
  Action?: unknown;
  Test?: unknown;
  Package?: unknown;
}

function goJson(out: string): Parsed | undefined {
  const tally = { pass: 0, fail: 0, skip: 0 };
  const failing: string[] = [];
  let seen = false;
  for (const l of out.split('\n')) {
    if (!l.startsWith('{')) continue;
    let e: GoEvent;
    try {
      e = JSON.parse(l) as GoEvent;
    } catch {
      continue;
    }
    seen = true;
    if (typeof e.Test !== 'string' || typeof e.Action !== 'string') continue;
    if (e.Action === 'pass' || e.Action === 'fail' || e.Action === 'skip') tally[e.Action] += 1;
    if (e.Action === 'fail') failing.push(`${String(e.Package ?? '')}.${e.Test}`);
  }
  if (!seen) return undefined;
  return {
    runner: 'go',
    passed: tally.pass,
    failed: tally.fail,
    skipped: tally.skip,
    failing: uniq(failing),
  };
}

function goText(out: string): Parsed | undefined {
  const marks = [...out.matchAll(/^\s*--- (PASS|FAIL|SKIP): (\S+)/gm)];
  const pkgs = /^(ok|FAIL|---)\s/m.test(out);
  if (marks.length === 0 && !pkgs) return undefined;
  const by = (k: string): number => marks.filter((m) => m[1] === k).length;
  const failing = marks.filter((m) => m[1] === 'FAIL').map((m) => m[2] as string);
  const passed = marks.length === 0 ? null : by('PASS');
  return {
    runner: 'go',
    passed,
    failed: marks.length === 0 ? null : by('FAIL'),
    skipped: marks.length === 0 ? null : by('SKIP'),
    failing: uniq(failing),
  };
}

const PARSERS: Record<ParserName, (out: string) => Parsed | undefined> = {
  vitest: parseVitest,
  jest: parseJest,
  pytest: parsePytest,
  go: (out) => goJson(out) ?? goText(out),
};

/** Runner messages that say no test ran. */
const NONE = [
  /\bno tests? (files? )?(were |was )?(found|ran|run|collected|executed)/i,
  /\[no test files\]/i,
  /\bcollected 0 items\b/i,
  /\brunning 0 tests\b/i,
];

/** Tries the preferred parser, then the others (a `pnpm test` script may run any of them). */
export function parseOutput(out: string, prefer?: ParserName): Parsed | undefined {
  const text = out.replace(ANSI, '');
  const order = (Object.keys(PARSERS) as ParserName[]).sort((a, b) =>
    a === prefer ? -1 : b === prefer ? 1 : 0,
  );
  for (const name of order) {
    const p = PARSERS[name](text);
    if (p) return p;
  }
  return undefined;
}

export interface RunFacts {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  error?: string;
  output: string;
}

/**
 * Failed beats passed; a pass needs a test that passed (else "no-tests", which proves
 * nothing); without any count the exit code decides (generic fallback).
 */
function status(f: RunFacts, p: Parsed | undefined): TestStatus {
  if (f.error !== undefined || f.timedOut || f.aborted || f.exitCode === null) return 'error';
  if ((p?.failed ?? 0) > 0) return 'failed';
  if ((p?.passed ?? 0) > 0) return f.exitCode === 0 ? 'passed' : 'failed';
  const none = NONE.some((re) => re.test(f.output));
  if (none || (p !== undefined && p.passed !== null)) {
    // pytest exits 5 when it collected nothing.
    return none || f.exitCode === 0 || f.exitCode === 5 ? 'no-tests' : 'failed';
  }
  return f.exitCode === 0 ? 'passed' : 'failed';
}

/** The evidence of one run: status, counts and failing names (exit code alone as a fallback). */
export function evidenceOf(facts: RunFacts, prefer?: ParserName): TestEvidence {
  const p = parseOutput(facts.output, prefer);
  return {
    status: status(facts, p),
    runner: p?.runner ?? 'exit-code',
    exitCode: facts.exitCode,
    passed: p?.passed ?? null,
    failed: p?.failed ?? null,
    skipped: p?.skipped ?? null,
    failing: p?.failing ?? [],
  };
}
