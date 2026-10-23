#!/usr/bin/env node
// Phase 1 reproducible demo: competence routing, fallback, budget, metrics. Offline by
// default with three mock providers; KPAI_DEMO_LIVE=1 also routes over real providers
// whose keys are set (or local servers running) — that spends real money.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAndInterrupt } from './lib/interrupt.mjs';

const bin = fileURLToPath(new URL('../apps/cli/dist/bin.js', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'kpai-demo1-'));
const env = { ...process.env, KPAI_HOME: home };
let failures = 0;

const MOCKS = [
  ['mock-alpha', 'US', 2, 10, 0.9, 0.6],
  ['mock-beta', 'EU', 0.5, 2, 0.7, 0.9],
  ['mock-gamma', 'local', 0, 0, 0.5, 0.5],
];
mkdirSync(join(home, 'providers'));
for (const [id, j, pi, po, code, writing] of MOCKS) {
  writeFileSync(
    join(home, 'providers', `${id}.yaml`),
    `id: ${id}\nname: ${id}\nkind: test\nadapter: mock\njurisdiction: ${j}\nretention: none\nmodels:\n  - id: m1\n    contextWindow: 32000\n    maxOutput: 4096\n    modalities: [text, code]\n    price: { inputPerMTok: ${pi}, outputPerMTok: ${po} }\n    competence: { code_generation: ${code}, test: ${code}, writing: ${writing}, critique: ${writing}, analysis: 0.6, research: 0.5, decision: 0.6 }\n`,
  );
}

function step(title, args, { expect = 0, extraEnv = {} } = {}) {
  console.log(`\n\x1b[1m▶ ${title}\x1b[0m\n$ kpai ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [bin, ...args], {
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(r.stdout + r.stderr);
  const ok = r.status === expect;
  if (!ok) failures++;
  console.log(ok ? `  ✔ exit ${r.status}` : `  ✘ exit ${r.status}, expected ${expect}`);
}

async function cancelStep() {
  console.log('\n\x1b[1m▶ Interrupt a routed run (Ctrl+C) — partial output kept\x1b[0m');
  if (process.platform === 'win32')
    return console.log('  (skipped on Windows: SIGINT cannot be sent to a child)');
  const args = [
    'run',
    '--allow-test',
    'write a parser [[slow]] with many many many words to stream',
  ];
  const code = await runAndInterrupt(bin, args, env);
  if (code !== 130) failures++;
  console.log(code === 130 ? '  ✔ exit 130 (cancelled)' : `  ✘ exit ${code}, expected 130`);
}

const T = '--allow-test';
const CODE = 'write a typescript function that validates an OAuth state parameter';
console.log(`KernelPAI phase 1 demo — journal in ${home}`);
step('Providers: 10 real (need keys or local servers) + offline mocks', ['providers']);
step('Mocks are never routed to unless allowed (kind "test")', ['route', CODE], { expect: 1 });
step('Dry run: classify → plan → route, one-line justification', ['route', T, '--verbose', CODE]);
const tight = { KPAI_BUDGET_TASK_USD: '0.012' };
step('Tight task budget, "economy": the cheaper model', ['route', T, '-p', 'economy', CODE], {
  extraEnv: tight,
});
step(
  'Same budget, "performance": the most competent model',
  ['route', T, '-p', 'performance', CODE],
  { extraEnv: tight },
);
step('French writing task routes to the best writer', [
  'route',
  T,
  'rédige un courriel pour annoncer la release',
]);
step('Run: execute the routed model, journal everything', ['run', T, CODE]);
step('Fallback: the chosen model is rate-limited', [
  'run',
  T,
  `${CODE} [[fail:rate_limit@mock-alpha]]`,
]);
step('Fallback chain: two providers down, the third answers', [
  'run',
  T,
  `${CODE} [[fail:unavailable@mock-alpha]] [[fail:unavailable@mock-beta]]`,
]);
step('Mid-stream failure: partial text discarded, fallback answers', [
  'run',
  T,
  `${CODE} [[midfail:unavailable@mock-alpha]]`,
]);
const gated = ['run', T, '--exclude', 'mock,mock-gamma', `${CODE} [[fail:unavailable@mock-beta]]`];
const econ = { KPAI_BUDGET_TASK_USD: '0.005', KPAI_PROFILE: 'economy' };
step('Every fallback is budget-checked: the pricier one is blocked', gated, {
  expect: 1,
  extraEnv: econ,
});
step(
  '…unless the user explicitly overrides (journaled)',
  [...gated.slice(0, 2), '--over-budget', ...gated.slice(2)],
  { extraEnv: econ },
);
step(
  'Every provider down: reported, nothing invented',
  ['run', T, `${CODE} [[fail:unavailable]]`],
  { expect: 1 },
);
step('Session budget (the session spans runs) blocks before spending', ['run', T, '--yes', CODE], {
  expect: 4,
  extraEnv: { KPAI_BUDGET_SESSION_USD: '0.0001' },
});
step('Above the confirmation threshold, non-interactive declines', ['run', T, CODE], {
  expect: 4,
  extraEnv: { KPAI_CONFIRM_ABOVE_USD: '0' },
});
await cancelStep();
if (process.env.KPAI_DEMO_LIVE === '1') {
  step('Live: route over real providers (spends money)', [
    'run',
    '--max-tokens',
    '128',
    'Explain in two sentences what OAuth PKCE protects against',
  ]);
}
step('Phase metrics from the journal (EUR at an explicit rate)', ['stats'], {
  extraEnv: { KPAI_CURRENCY: 'EUR', KPAI_USD_RATE: '0.92' },
});
step('Journal hash chain intact', ['verify']);

console.log(
  failures === 0 ? '\n\x1b[32mDemo passed.\x1b[0m' : `\n\x1b[31m${failures} step(s) failed.\x1b[0m`,
);
process.exitCode = failures === 0 ? 0 : 1;
