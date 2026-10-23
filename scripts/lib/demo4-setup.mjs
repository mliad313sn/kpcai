// Setup for the phase 4 demo: a throwaway $KPAI_HOME with offline mock providers, a git
// repository with a little source code (for `kpai bench`), and a clean environment.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Two mocks close on analysis at the same price (alpha slightly ahead), so measured
 * competence can visibly change who gets an analysis node; the others lead elsewhere.
 */
const MOCKS = [
  ['mock-alpha', 2, 10, { analysis: 0.8, code_generation: 0.6, test: 0.6, critique: 0.6 }],
  ['mock-beta', 2, 10, { analysis: 0.78, code_generation: 0.95, test: 0.6, critique: 0.6 }],
  ['mock-gamma', 1, 5, { analysis: 0.5, code_generation: 0.6, test: 0.95, critique: 0.6 }],
  ['mock-delta', 2, 10, { analysis: 0.5, code_generation: 0.6, test: 0.6, critique: 0.95 }],
];

function descriptor([id, pi, po, comp]) {
  const c = Object.entries({ writing: 0.6, research: 0.5, decision: 0.6, ...comp })
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  return `id: ${id}\nname: ${id}\nkind: test\nadapter: mock\njurisdiction: US\nretention: none\nmodels:\n  - id: m1\n    contextWindow: 64000\n    maxOutput: 4096\n    modalities: [text, code]\n    price: { inputPerMTok: ${pi}, outputPerMTok: ${po} }\n    competence: { ${c} }\n`;
}

const fn = (n) =>
  `export function compute${n}(a: number, b: number): number {\n  const x = a * ${n} + b;\n  return x > 10 ? x - 10 : x + 1;\n}\n`;

/** Creates the demo world; returns `{ base, home, repo, env, git }`. */
export function demoWorld() {
  const base = mkdtempSync(join(tmpdir(), 'kpai-demo4-'));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  // Offline by construction: no key or base URL from the shell, local probes on a closed port.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/_API_(KEY|TOKEN)$|_BASE_URL$|^OLLAMA_/.test(k)),
  );
  Object.assign(env, {
    KPAI_HOME: home,
    OLLAMA_HOST: 'http://127.0.0.1:9',
    LLAMACPP_BASE_URL: 'http://127.0.0.1:9/v1',
    KPAI_CONFIRM_ABOVE_USD: '100',
    KPAI_LANG: 'en',
  });
  mkdirSync(join(home, 'providers'), { recursive: true });
  for (const m of MOCKS) writeFileSync(join(home, 'providers', `${m[0]}.yaml`), descriptor(m));
  mkdirSync(join(repo, 'src'), { recursive: true });
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'demo@kernelpai.local');
  git('config', 'user.name', 'demo');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# demo app\n');
  writeFileSync(join(repo, 'src', 'calc.ts'), [1, 2, 3, 4].map(fn).join('\n'));
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { base, home, repo, env, git };
}

/** Prints a check line and counts failures. */
export function checker() {
  const state = { failures: 0 };
  const check = (ok, text) => {
    if (!ok) state.failures++;
    console.log(ok ? `  ✔ ${text}` : `  ✘ ${text}`);
    return ok;
  };
  return { state, check };
}

export const say = (title) => console.log(`\n\x1b[1m▶ ${title}\x1b[0m`);
export const usd = (x) => `$${Number(x).toFixed(4)}`;
export const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(0)} %`);
