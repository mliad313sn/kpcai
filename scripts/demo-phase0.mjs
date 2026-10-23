#!/usr/bin/env node
// Phase 0 reproducible demo. Offline by default; set KPAI_DEMO_LIVE=1 to also call
// Ollama (if running) and Anthropic (if ANTHROPIC_API_KEY is set; uses the cheapest model).
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAndInterrupt } from './lib/interrupt.mjs';

const bin = fileURLToPath(new URL('../apps/cli/dist/bin.js', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'kpai-demo-'));
const env = { ...process.env, KPAI_HOME: home };
let failures = 0;

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
  return r.stdout;
}

async function cancelStep() {
  console.log('\n\x1b[1m▶ Interrupt a running call (Ctrl+C) — partial output is kept\x1b[0m');
  if (process.platform === 'win32')
    return console.log('  (skipped on Windows: SIGINT cannot be sent to a child)');
  const args = ['ask', '-m', 'mock/echo', '[[slow]] a long answer that will be interrupted'];
  const code = await runAndInterrupt(bin, args, env);
  if (code !== 130) failures++;
  console.log(code === 130 ? '  ✔ exit 130 (cancelled)' : `  ✘ exit ${code}, expected 130`);
}

console.log(`KernelPAI phase 0 demo — journal in ${home}`);
step('Detect providers and models', ['providers']);
step('Principle 1: no model is ever picked "by default"', ['ask', 'hello'], { expect: 2 });
step('Ask an explicit model; stream, estimate, journal', [
  'ask',
  '-m',
  'mock/echo',
  'Explain what a kernel does',
]);
step(
  'Provider failure is classified and journaled',
  ['ask', '-m', 'mock/echo', '[[fail:unavailable]]'],
  { expect: 1 },
);
step(
  'Principle 6: estimate above threshold needs confirmation',
  ['ask', '-m', 'mock/echo', 'expensive?'],
  {
    expect: 4,
    extraEnv: { KPAI_CONFIRM_ABOVE_USD: '0' },
  },
);
await cancelStep();
if (process.env.KPAI_DEMO_LIVE === '1') {
  const local = step('Live: Ollama (local)', ['providers']);
  const m = /ollama\/(\S+)/.exec(local);
  if (m)
    step(`Live: ask ollama/${m[1]}`, [
      'ask',
      '-y',
      '-m',
      `ollama/${m[1]}`,
      '--max-tokens',
      '64',
      'Say hi in five words',
    ]);
  if (process.env.ANTHROPIC_API_KEY)
    step('Live: ask Anthropic', [
      'ask',
      '-y',
      '-m',
      'anthropic/claude-haiku-5-5',
      '--max-tokens',
      '64',
      'Say hi in five words',
    ]);
}
const sessions = step('List journaled sessions', ['log']);
const id = sessions
  .split('\n')
  .find((l) => l.includes('Explain'))
  ?.slice(0, 8);
step('Show one session, event by event', ['log', '--session', id]);
step('Export it as Markdown', ['export', id]);
step('Verify the tamper-evident hash chain', ['verify']);

console.log(
  failures === 0 ? '\n\x1b[32mDemo passed.\x1b[0m' : `\n\x1b[31m${failures} step(s) failed.\x1b[0m`,
);
process.exitCode = failures === 0 ? 0 : 1;
