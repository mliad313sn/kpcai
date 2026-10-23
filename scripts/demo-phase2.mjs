#!/usr/bin/env node
// Phase 2 reproducible demo: task graph, cross-provider review, debate, tool bus, patches.
// Offline with four mock providers in a throwaway git repository. KPAI_DEMO_LIVE=1 also
// plans with real providers (dry run only — `kpai plan` spends nothing).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../apps/cli/dist/bin.js', import.meta.url));
const base = mkdtempSync(join(tmpdir(), 'kpai-demo2-'));
const home = join(base, 'home');
const repo = join(base, 'repo');
const env = { ...process.env, KPAI_HOME: home };
let failures = 0;

// Each mock is best at one task type, so the router hands each role to a different model.
const MOCKS = [
  [
    'mock-alpha',
    'US',
    3,
    15,
    { analysis: 0.95, decision: 0.9, code_generation: 0.6, test: 0.5, critique: 0.6 },
  ],
  [
    'mock-beta',
    'EU',
    2,
    10,
    { analysis: 0.6, decision: 0.6, code_generation: 0.95, test: 0.6, critique: 0.6 },
  ],
  [
    'mock-gamma',
    'local',
    1,
    5,
    { analysis: 0.5, decision: 0.5, code_generation: 0.6, test: 0.95, critique: 0.6 },
  ],
  [
    'mock-delta',
    'CA',
    2,
    10,
    { analysis: 0.6, decision: 0.7, code_generation: 0.6, test: 0.6, critique: 0.95 },
  ],
];
mkdirSync(join(home, 'providers'), { recursive: true });
for (const [id, j, pi, po, comp] of MOCKS) {
  const c = Object.entries({ writing: 0.5, research: 0.5, ...comp })
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  writeFileSync(
    join(home, 'providers', `${id}.yaml`),
    `id: ${id}\nname: ${id}\nkind: test\nadapter: mock\njurisdiction: ${j}\nretention: none\nmodels:\n  - id: m1\n    contextWindow: 64000\n    maxOutput: 4096\n    modalities: [text, code]\n    price: { inputPerMTok: ${pi}, outputPerMTok: ${po} }\n    competence: { ${c} }\n`,
  );
}
mkdirSync(repo);
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 'demo@kernelpai.local');
git('config', 'user.name', 'demo');
writeFileSync(join(repo, 'README.md'), '# demo app\n');
git('add', '-A');
git('commit', '-qm', 'init');

function step(title, args, { expect = 0, extraEnv = {} } = {}) {
  console.log(`\n\x1b[1m▶ ${title}\x1b[0m\n$ kpai ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: repo,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(r.stderr + r.stdout);
  const ok = r.status === expect;
  if (!ok) failures++;
  console.log(ok ? `  ✔ exit ${r.status}` : `  ✘ exit ${r.status}, expected ${expect}`);
  return r.stdout + r.stderr;
}

const T = '--allow-test';
const REQ =
  'add an OAuth state validator with tests [[diff:src/oauth-state.ts]] [[testdiff:test/oauth-state.test.ts]]';
console.log(`KernelPAI phase 2 demo — repo ${repo}`);
step('Tools every model can be given, with their risk', ['tools']);
step('Plan: the graph, who does what, cost before launch (nothing runs)', ['plan', T, REQ]);
step('Do: three models build, critics from other providers review, a fourth reviews', [
  'do',
  T,
  '--new-session',
  '--yes',
  REQ,
]);
step('Do with --apply: approved patches go through the tool bus (git.apply)', [
  'do',
  T,
  '--new-session',
  '--apply',
  '--yes',
  '--yes-apply',
  REQ,
]);
const status = git('status', '--short', '-uall').stdout;
console.log(`$ git status --short -uall\n${status}`);
if (!status.includes('src/oauth-state.ts') || !status.includes('test/oauth-state.test.ts')) {
  failures++;
  console.log('  ✘ expected both files to be created');
}
step('A critic rejects: the author revises, the critic approves the revision', [
  'do',
  T,
  '--new-session',
  'draft an email announcing the v2 release [[reject@mock-delta]] [[reject@mock-beta]] [[reject@mock-alpha]] [[reject@mock-gamma]]',
]);
step(
  'Principle 2: with one provider, no self-review — refused before spending',
  [
    'do',
    T,
    '--new-session',
    '--exclude',
    'mock,mock-alpha,mock-beta,mock-gamma',
    'draft an email announcing the v2 release',
  ],
  { expect: 1 },
);
// --yes accepts the cost prompt: since D-021 the approved figure is the band's top, above the
// $0.10 confirmation threshold here. Writes would still need --yes-apply.
step('…unless explicitly waived (journaled)', [
  'do',
  T,
  '--new-session',
  '--yes',
  '--allow-same-provider',
  '--exclude',
  'mock,mock-alpha,mock-beta,mock-gamma',
  'draft an email announcing the v2 release',
]);
step(
  'Budget: the whole graph is checked before anything runs',
  ['do', T, '--new-session', '--yes', REQ],
  {
    expect: 4,
    extraEnv: { KPAI_BUDGET_SESSION_USD: '0.0001' },
  },
);
if (process.env.KPAI_DEMO_LIVE === '1')
  step('Live: plan over real providers (dry run)', ['plan', REQ]);
step('Metrics from the journal', ['stats']);
step('Journal hash chain intact', ['verify']);

console.log(
  failures === 0 ? '\n\x1b[32mDemo passed.\x1b[0m' : `\n\x1b[31m${failures} step(s) failed.\x1b[0m`,
);
process.exitCode = failures === 0 ? 0 : 1;
