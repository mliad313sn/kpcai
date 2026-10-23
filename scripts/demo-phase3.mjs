#!/usr/bin/env node
// Phase 3 reproducible demo: KP Studio's kernel server (`kpai studio`) driven over its
// WebSocket protocol, as the web, desktop and terminal consoles do. Offline: four mock
// providers in a throwaway git repository, loopback only, no API key read from the shell.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeCode, connectRpc, startStudio } from './lib/studio-client.mjs';

const bin = fileURLToPath(new URL('../apps/cli/dist/bin.js', import.meta.url));
const base = mkdtempSync(join(tmpdir(), 'kpai-demo3-'));
const home = join(base, 'home');
const repo = join(base, 'repo');
let failures = 0;

// Offline by construction: no provider key or base URL from the developer's shell, and the
// local-model probes pointed at a closed loopback port.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/_API_(KEY|TOKEN)$|_BASE_URL$|^OLLAMA_/.test(k)),
);
Object.assign(env, {
  KPAI_HOME: home,
  OLLAMA_HOST: 'http://127.0.0.1:9',
  LLAMACPP_BASE_URL: 'http://127.0.0.1:9/v1',
  KPAI_CONFIRM_ABOVE_USD: '100',
});

const MOCKS = [
  ['mock-alpha', 3, 15, { analysis: 0.95, code_generation: 0.6, test: 0.6, critique: 0.6 }],
  ['mock-beta', 2, 10, { analysis: 0.6, code_generation: 0.95, test: 0.6, critique: 0.6 }],
  ['mock-gamma', 1, 5, { analysis: 0.6, code_generation: 0.6, test: 0.95, critique: 0.6 }],
  ['mock-delta', 2, 10, { analysis: 0.6, code_generation: 0.6, test: 0.6, critique: 0.95 }],
];
mkdirSync(join(home, 'providers'), { recursive: true });
for (const [id, pi, po, comp] of MOCKS) {
  const c = Object.entries({ writing: 0.6, research: 0.5, decision: 0.6, ...comp })
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  writeFileSync(
    join(home, 'providers', `${id}.yaml`),
    `id: ${id}\nname: ${id}\nkind: test\nadapter: mock\njurisdiction: US\nretention: none\nmodels:\n  - id: m1\n    contextWindow: 64000\n    maxOutput: 4096\n    modalities: [text, code]\n    price: { inputPerMTok: ${pi}, outputPerMTok: ${po} }\n    competence: { ${c} }\n`,
  );
}
mkdirSync(repo);
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 'demo@kernelpai.local');
git('config', 'user.name', 'demo');
git('config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'README.md'), '# demo app\n');
writeFileSync(join(repo, 'AGENTS.md'), 'Use TypeScript strict mode. Keep functions short.\n');
git('add', '-A');
git('commit', '-qm', 'init');

const say = (title) => console.log(`\n\x1b[1m▶ ${title}\x1b[0m`);
function check(ok, text) {
  if (!ok) failures++;
  console.log(ok ? `  ✔ ${text}` : `  ✘ ${text}`);
  return ok;
}
const usd = (x) => `$${Number(x).toFixed(4)}`;
const ms = (x) => (typeof x === 'number' ? `${x.toFixed(3)} ms` : 'n/a');
const T = { allowTest: true };
const REQ =
  'add an OAuth state validator with tests [[diff:src/oauth-state.ts]] [[testdiff:test/oauth-state.test.ts]]';
const REPORT = 'write a short report about the release';

/** Band bookkeeping for the phase report: did the run's real cost land in its band? */
const bands = [];
function recordBand(label, estimate, costUsd) {
  const band = estimate.band ?? { lowUsd: estimate.minUsd, highUsd: estimate.totalUsd };
  const inBand = costUsd >= band.lowUsd && costUsd <= band.highUsd;
  bands.push({ label, ...band, costUsd, inBand });
  console.log(
    `  cost ${usd(costUsd)} vs band ${usd(band.lowUsd)}–${usd(band.highUsd)} (${band.basis ?? 'min–total'}), cap ${usd(estimate.totalUsd)}: ${inBand ? 'inside' : 'outside'} the band`,
  );
}

async function runToEnd(c, params, timeoutMs = 60_000) {
  const { runId } = await c.call('run.start', params);
  const done = await c.waitFor(
    (n) => n.method === 'run.done' && n.params.runId === runId,
    timeoutMs,
    'run.done',
  );
  return { runId, done: done.params };
}

console.log(`KernelPAI phase 3 demo — KP Studio kernel server — repo ${repo}`);

say('Start KP Studio: `kpai studio` binds 127.0.0.1 on a random port, token in the URL fragment');
const studio = await startStudio(bin, { cwd: repo, env });
console.log(`$ kpai studio\n  ${studio.url.replace(/#token=.*/, '#token=<redacted>')}`);
check(studio.url.startsWith('http://127.0.0.1:'), 'loopback URL printed');
const serverFile = join(home, 'server.json');
check(existsSync(serverFile), '$KPAI_HOME/server.json written');
if (process.platform !== 'win32')
  check(
    (statSync(serverFile).mode & 0o777) === 0o600,
    'server.json is readable by its owner only (0600)',
  );
const page = await fetch(`http://127.0.0.1:${studio.port}/`);
check(page.ok && (await page.text()).includes('KP Studio'), 'the built KP Studio UI is served');

const refused = await closeCode(studio.port, 'wrong-token-123456');
check(refused === 4401, `a wrong token is refused (close ${refused})`);

const c = await connectRpc(studio.port, studio.token);
try {
  const hello = await c.call('kernel.hello', { client: 'demo-phase3', protocol: 1 });
  check(hello.protocol === 1, `connected (protocol ${hello.protocol})`);
  const { providers } = await c.call('providers.list', {});
  const ready = providers.filter((p) => p.available).map((p) => p.id);
  console.log(`  providers ready: ${ready.join(', ')}`);

  say('Plan (R-301, R-302, R-303, R-306): the graph, who does what, why, and the cost band');
  const plan = await c.call('plan', { request: REQ, options: T });
  for (const n of plan.estimate.nodes)
    console.log(
      `  #${n.nodeId.padEnd(15)} ${n.protocol.padEnd(14)} ${n.ref.provider}/${n.ref.model}  ${n.reason ?? ''}`,
    );
  const b = plan.estimate.band;
  console.log(
    `  estimate ${usd(b.lowUsd)}–${usd(b.highUsd)} (${b.basis}) · cap ${usd(plan.estimate.totalUsd)}`,
  );
  console.log(`  rules: ${plan.rules.files.map((f) => f.path).join(', ')} (${plan.rules.trust})`);
  check(
    plan.rules.files.some((f) => f.path === 'AGENTS.md'),
    'AGENTS.md is listed in the plan',
  );
  // The kernel attaches a reason only when an unconstrained re-route agrees with the
  // estimate (ADR-0019); a node whose model is set by critic diversity gets none (reported).
  const unexplained = plan.estimate.nodes.filter((n) => !n.reason).map((n) => `#${n.nodeId}`);
  check(unexplained.length < plan.estimate.nodes.length, 'nodes carry the router reason');
  if (unexplained.length)
    console.log(`  ⚠ no reason shown for ${unexplained.join(', ')} (known gap)`);

  say(
    'Edit the plan, validate it, run exactly that graph, isolated in its own worktree (R-301, R-307)',
  );
  const nodes = plan.graph.nodes.map((n) =>
    n.id === 'implementation' ? { ...n, model: { provider: 'mock-alpha', model: 'm1' } } : n,
  );
  const checked = await c.call('plan.validate', { planId: plan.planId, graph: { nodes } });
  console.log(`  plan.validate: ok=${checked.ok}; ${checked.changes.join('; ')}`);
  check(checked.ok, 'the edited plan is valid');
  const edited = await runToEnd(c, {
    request: REQ,
    planId: plan.planId,
    graph: { nodes },
    options: { ...T, isolated: true },
  });
  const states = c.notes.filter(
    (n) => n.method === 'run.event' && n.params.runId === edited.runId,
  ).length;
  console.log(`  ${states} live events streamed; worktree ${edited.done.worktree}`);
  const author = edited.done.result.results.implementation.contributions[0];
  check(
    author.ref.provider === 'mock-alpha',
    `the edited model ran: ${author.role} = ${author.ref.provider}/${author.ref.model}`,
  );
  check(edited.done.patches.length === 2, `${edited.done.patches.length} approved patches`);
  recordBand('edited code run', checked.estimate ?? plan.estimate, edited.done.result.costUsd);

  say('Steer mid-run (R-304): pause, add an instruction to a pending node, resume');
  const slow = await c.call('plan', { request: `${REQ} [[slow]]`, options: T });
  const { runId: steerId } = await c.call('run.start', {
    request: `${REQ} [[slow]]`,
    planId: slow.planId,
    options: { ...T, isolated: false },
  });
  await c.waitFor((n) => n.method === 'run.event' && n.params.runId === steerId, 20_000, 'event');
  await c.call('run.pause', { runId: steerId });
  await c.waitFor((n) => n.method === 'run.state' && n.params.state === 'paused', 20_000, 'pause');
  await c.call('run.instruct', { runId: steerId, nodeId: 'review', text: 'mention token expiry' });
  await c.call('run.resume', { runId: steerId });
  const steered = await c.waitFor(
    (n) => n.method === 'run.done' && n.params.runId === steerId,
    60_000,
    'run.done',
  );
  const controls = c.notes
    .filter((n) => n.method === 'run.control' && n.params.runId === steerId)
    .map((n) => n.params.event.type);
  console.log(`  controls: ${controls.join(' → ')}`);
  check(
    ['run_paused', 'instruction_added', 'run_resumed'].every((x) => controls.includes(x)),
    'pause, instruction and resume were applied and journaled',
  );
  recordBand('steered run', slow.estimate, steered.params.result.costUsd);

  say('Apply the patches in the worktree, then merge back (each write confirmed with its diff)');
  c.answer = (q) => q.kind === 'patch';
  const applied = await c.call('patches.apply', { runId: edited.runId });
  check(
    applied.results.every((r) => r.ok),
    `${applied.results.length} patches applied in the worktree`,
  );
  check(!existsSync(join(repo, 'src/oauth-state.ts')), 'the user workspace is untouched so far');
  const merged = await c.call('run.merge', { runId: edited.runId });
  console.log(`  merged: ${merged.files.join(', ')}`);
  console.log(`$ git status --short -uall\n${git('status', '--short', '-uall').stdout}`);
  check(existsSync(join(repo, 'src/oauth-state.ts')), 'merge-back wrote the files');

  say('Checkpoints and restore (R-305): silence means no; yes restores the tree');
  const { checkpoints } = await c.call('run.checkpoints', { runId: edited.runId });
  for (const cp of checkpoints) console.log(`  ${cp.n}. ${cp.label} (${cp.where})`);
  const before = checkpoints.find((x) => x.where === 'workspace');
  c.answer = () => false;
  const no = await c.call('run.restore', { runId: edited.runId, ref: before.ref });
  check(!no.restored && existsSync(join(repo, 'src/oauth-state.ts')), `declined: ${no.reason}`);
  c.answer = (q) => q.kind === 'restore';
  const yes = await c.call('run.restore', { runId: edited.runId, ref: before.ref });
  console.log(`  restored; deleted ${yes.deleted.join(', ')}`);
  check(
    yes.restored && !existsSync(join(repo, 'src/oauth-state.ts')),
    'the workspace is back to its state before the merge',
  );
  check(readFileSync(join(repo, 'README.md'), 'utf8') === '# demo app\n', 'README.md unchanged');

  say('Artifacts (D-019): a report run; an unreviewed document is saved only after "NOT REVIEWED"');
  const doc = await c.call('plan', { request: REPORT, options: T });
  const art = await runToEnd(c, {
    request: REPORT,
    planId: doc.planId,
    options: { ...T, isolated: false },
  });
  for (const a of art.done.artifacts)
    console.log(
      `  ${a.path.padEnd(12)} ${a.kind.padEnd(8)} reviewed=${a.reviewed} ${a.bytes} bytes`,
    );
  recordBand('report run', doc.estimate, art.done.result.costUsd);
  c.answer = (q) => q.kind === 'artifact';
  const saved = await c.call('artifacts.apply', { runId: art.runId, paths: ['gather.md'] });
  const asked = c.confirms.at(-1);
  check(/NOT REVIEWED/.test(asked.question), 'the confirmation said NOT REVIEWED');
  check(
    saved.results[0].ok && existsSync(join(repo, 'gather.md')),
    'gather.md saved after the yes',
  );

  say('Runs manager (R-307): runs.list');
  const { runs } = await c.call('runs.list', {});
  for (const r of runs)
    console.log(
      `  ${r.runId.slice(0, 8)} ${r.state.padEnd(6)} ${usd(r.costUsd)} isolated=${r.isolated} verdict=${r.verdict ?? '—'} patches=${r.patches} artifacts=${r.artifacts}`,
    );
  check(runs.length === 3, `${runs.length} runs listed`);

  say('Journal metrics and integrity');
  const stats = await c.call('stats', {});
  const m = stats.metrics ?? stats;
  console.log(
    `  router latency p50 ${ms(m.routerLatencyMs?.p50)} · p95 ${ms(m.routerLatencyMs?.p95)} (${m.routerLatencyMs?.samples} decisions)`,
  );
  console.log(
    `  tasks ${m.tasks} · calls ${m.calls} · fallback rate ${m.fallbackRate} · cost per task ${usd(m.avgCostPerTaskUsd ?? 0)} · cost estimate error ${m.costError?.meanAbsPct?.toFixed?.(1)} %`,
  );
  const hits = bands.filter((x) => x.inBand).length;
  console.log(`  estimate band hit rate on these mock runs: ${hits}/${bands.length}`);
  const verify = await c.call('journal.verify', {});
  check(verify.ok, `journal hash chain intact (${verify.checked} events)`);
} finally {
  c.close();
}

say('Stop the server (Ctrl+C)');
const stopped = await studio.stop();
if (process.platform !== 'win32') {
  check(stopped.code === 0, `kpai studio exited ${stopped.code}`);
  check(!existsSync(serverFile), 'server.json removed on exit');
}

say('Domain packs: `kpai pack detect` on a folder of CSV files');
const data = join(base, 'sales-data');
mkdirSync(data);
writeFileSync(join(data, 'sales.csv'), 'region,month,sales\nnorth,2026-09,120\nsouth,2026-09,95\n');
writeFileSync(join(data, 'returns.csv'), 'region,returns\nnorth,4\nsouth,7\n');
const detect = spawnSync(process.execPath, [bin, 'pack', 'detect'], {
  cwd: data,
  env,
  encoding: 'utf8',
});
process.stdout.write(`$ kpai pack detect\n${detect.stdout}${detect.stderr}`);
check(
  detect.status === 0 && /data-science/.test(detect.stdout),
  'the data-science pack matches the CSV folder',
);

console.log(
  failures === 0
    ? '\n\x1b[32mDemo passed.\x1b[0m'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`,
);
process.exitCode = failures === 0 ? 0 : 1;
