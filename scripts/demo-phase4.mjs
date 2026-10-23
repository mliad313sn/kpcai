#!/usr/bin/env node
// Phase 4 reproducible demo: memory and learning. Offline: four mock providers in a
// throwaway git repository, `kpai studio` on loopback driven over its protocol, then the
// CLI (`kpai bench`, `kpai memory`, `kpai stats`). No API key is read from the shell.
// Shows: memory with a confirmed model proposal and a local-only fact; grades changing the
// router's evidence line and its choice; the bench; replay compare; fork; a dispute; and
// the accuracy and productivity numbers, all read back from the journal.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { connectRpc, startStudio } from './lib/studio-client.mjs';
import { checker, demoWorld, pct, say, usd } from './lib/demo4-setup.mjs';

const root = new URL('../', import.meta.url);
const bin = fileURLToPath(new URL('apps/cli/dist/bin.js', root));
const lib = (p) => import(new URL(`packages/${p}/dist/index.js`, root).href);
const { Journal } = await lib('journal');
const { CompetenceStore, productivity } = await lib('learning');
const { Kernel } = await lib('kernel');

const { home, repo, env, git } = demoWorld();
const { state, check } = checker();
const T = { allowTest: true, isolated: false };
const ASK = 'what does the README say?';
// `[[reject]]`: every critic rejects the first draft, so review findings lead to revisions.
const CODE =
  'add an OAuth state validator with tests [[diff:src/oauth.ts]] [[testdiff:test/oauth.test.ts]] [[reject]]';
const VOTE =
  'which license should we pick? [[vote:MIT@mock-alpha]] [[vote:Apache@mock-beta]] [[vote:GPL@mock-gamma]] [[vote:BSD@mock-delta]]';
const metrics = {};

async function run(c, request, extra = {}) {
  const plan = await c.call('plan', { request, options: T });
  const { runId } = await c.call('run.start', {
    request,
    planId: plan.planId,
    options: T,
    ...extra,
  });
  const done = await c.waitFor(
    (n) => n.method === 'run.done' && n.params.runId === runId,
    60_000,
    'run.done',
  );
  return { plan, runId, done: done.params };
}

const reasonOf = (plan, id) => plan.estimate.nodes.find((n) => n.nodeId === id)?.reason ?? '';

async function allEvents(c) {
  const { sessions } = await c.call('sessions.list', { limit: 1000 });
  const out = [];
  for (const s of sessions)
    out.push(...(await c.call('sessions.events', { sessionId: s.id, limit: 100_000 })).events);
  return out.sort((a, b) => a.seq - b.seq);
}

console.log(`KernelPAI phase 4 demo — memory and learning — repo ${repo}`);
const studio = await startStudio(bin, { cwd: repo, env, args: ['--allow-test'] });
const c = await connectRpc(studio.port, studio.token);
try {
  say('Memory (ADR-0027): a model proposes, a human confirms; a local-only fact stays local');
  const proposing = `${ASK}\n\`\`\`memory\n- [project] Deploy with make release\n\`\`\``;
  const first = await run(c, proposing);
  const { pending } = await c.call('memory.pending', {});
  for (const p of pending)
    console.log(
      `  proposed: "${p.text}" by ${p.provenance.source} (${p.provenance.evidence.join(', ')})`,
    );
  check(
    pending.length === 1 && pending[0].provenance.evidence.includes(`run:${first.runId}`),
    'the proposal waits for a human, with the run as evidence',
  );
  const { fact } = await c.call('memory.confirm', { id: pending[0].id });
  check(
    fact.provenance.source.startsWith('mock-') && !!fact.provenance.confirmed,
    `confirmed: kept with source ${fact.provenance.source}, confirmed ${fact.provenance.confirmed}`,
  );
  await c.call('memory.add', { layer: 'project', text: 'Use pnpm for every install' });
  const secret = 'Lab build host is gpu-box-55217';
  await c.call('memory.add', { layer: 'project', text: secret, localOnly: true });
  const injected = await run(c, ASK);
  const mem = injected.plan.memory;
  for (const f of mem.included)
    console.log(
      `  injected ${f.id} source=${f.source} trust=${f.trust}${f.localOnly ? ' local-only' : ''}`,
    );
  console.log(
    `  ${mem.usedTokens} memory tokens per node (budget ${mem.budgetTokens}); ${mem.localOnly} local-only fact withheld from cloud providers`,
  );
  metrics.memoryTokensPerNode = mem.usedTokens;
  metrics.memoryNodes = injected.plan.graph.nodes.length;
  const events = await allEvents(c);
  const calls = events.filter(
    (e) =>
      e.type === 'call' &&
      e.seq > (events.find((x) => x.payload.action === 'memory confirmed')?.seq ?? 0),
  );
  check(
    calls.length > 0 &&
      calls.every((e) => JSON.stringify(e.payload.request).includes('Deploy with make release')),
    `the confirmed fact reached all ${calls.length} later calls`,
  );
  check(
    !JSON.stringify(events).includes('gpu-box-55217'),
    'the local-only fact is in no request and nowhere in the journal',
  );

  say("Learning (ADR-0028, R-401): grades become the router's evidence, then change its choice");
  const before = await c.call('plan', { request: ASK, options: T });
  console.log(`  before: #look ${reasonOf(before, 'look')}`);
  const graded = [];
  for (let i = 0; i < 5; i++) {
    const r = await run(c, ASK);
    graded.push(r.runId);
    await c.call('grade', { runId: r.runId, nodeId: 'look', grade: 'good', author: 'demo-user' });
  }
  const t0 = performance.now();
  const good = await c.call('plan', { request: ASK, options: T });
  metrics.planMsWithStore = performance.now() - t0;
  console.log(`  after 5 good grades: #look ${reasonOf(good, 'look')}`);
  check(
    /; evidence: approved 5\/5 analysis tasks here/.test(reasonOf(good, 'look')),
    'the reason line cites the evidence',
  );
  for (const id of graded)
    await c.call('grade', { runId: id, nodeId: 'look', grade: 'bad', author: 'demo-user' });
  const bad = await c.call('plan', { request: ASK, options: T });
  const was = before.estimate.nodes.find((n) => n.nodeId === 'look').ref.provider;
  const now = bad.estimate.nodes.find((n) => n.nodeId === 'look').ref.provider;
  console.log(`  after the same human regraded them bad: #look ${reasonOf(bad, 'look')}`);
  check(was !== now, `routing changed: ${was} → ${now} (bounded update, ADR-0028 §5)`);
  const { entries } = await c.call('competence', {});
  for (const e of entries)
    console.log(
      `  competence ${e.ref.provider}/${e.ref.model} ${e.taskType}: ${e.score.toFixed(2)} (${e.samples}) ${e.evidence}`,
    );

  say('Replay (R-403): rerun a node with another model, side by side with the original');
  const code = await run(c, CODE);
  const rp = await c.call('run.replay', {
    runId: code.runId,
    nodeId: 'implementation',
    model: { provider: 'mock-alpha', model: 'm1' },
  });
  for (const [k, a] of [
    ['original', rp.original],
    ['replay', rp.replay],
  ])
    console.log(
      `  ${k.padEnd(8)} ${a.protocol} ${a.models
        .map((m) => m.provider)
        .join('+')
        .padEnd(28)} ${usd(a.costUsd)} ${a.durationMs} ms  ${a.output.split('\n')[0].slice(0, 50)}`,
    );
  console.log(
    `  same output: ${rp.comparison.sameOutput} · cost delta ${usd(rp.comparison.costDeltaUsd)}`,
  );
  check(
    rp.replay.models[0].provider === 'mock-alpha' && rp.original.ok,
    'replayed beside the original, which is kept',
  );
  metrics.replay = { original: rp.original.costUsd, replay: rp.replay.costUsd };

  say('Fork (R-403): from #tests, reuse the finished upstream, run and pay only what follows');
  const fp = await c.call('run.forkPlan', {
    runId: code.runId,
    nodeId: 'tests',
    edit: { instruction: 'cover the empty state' },
  });
  console.log(
    `  reused ${fp.reused.join(', ')} · rerun ${fp.rerun.join(', ')} · likely ${usd(fp.estimate.expectedUsd)} cap ${usd(fp.estimate.capUsd)} (parent likely ${usd(code.plan.estimate.expectedUsd)})`,
  );
  const { runId: forkId } = await c.call('run.fork', { planId: fp.planId });
  const forked = (
    await c.waitFor((n) => n.method === 'run.done' && n.params.runId === forkId, 60_000, 'run.done')
  ).params;
  const rerunCost = fp.rerun.reduce((a, id) => a + forked.result.results[id].costUsd, 0);
  console.log(`  fork billed ${usd(rerunCost)} vs parent ${usd(code.done.result.costUsd)}`);
  check(
    rerunCost < code.done.result.costUsd && rerunCost <= fp.estimate.capUsd,
    'the fork paid only for the rerun nodes, inside its cap',
  );
  metrics.fork = { parent: code.done.result.costUsd, fork: rerunCost, cap: fp.estimate.capUsd };

  say('Dispute (R-405): a 1–1–1 vote asks the human; "no" fails closed, a choice settles it');
  const edit = async () => {
    const p = await c.call('plan', { request: VOTE, options: T });
    return { graph: { nodes: p.graph.nodes.map((n) => ({ ...n, protocol: 'vote' })) } };
  };
  c.answer = () => false;
  const refused = await run(c, VOTE, await edit());
  const asked = c.confirms.filter((q) => q.kind === 'dispute').at(-1);
  console.log(
    `  asked: ${asked.dispute.reason}; options ${asked.dispute.options.map((o) => `"${o.text}"`).join(', ')}`,
  );
  check(
    refused.done.result.states.decision === 'failed' &&
      refused.done.result.results.decision.output === '',
    'answered no: the node failed closed, nothing delivered',
  );
  c.answer = (q) => (q.kind === 'dispute' ? { ok: true, choice: q.dispute.options[0].id } : false);
  const settled = await run(c, VOTE, await edit());
  check(
    settled.done.result.states.decision === 'done',
    `settled by the human: "${settled.done.result.results.decision.output}"`,
  );

  say('Changes for the productivity metrics: apply a run in place, then roll one patch back');
  c.answer = (q) => q.kind === 'patch' || q.kind === 'restore';
  const applied = await c.call('patches.apply', { runId: code.runId });
  check(
    applied.results.every((r) => r.ok),
    `${applied.results.length} patches applied, each after a checkpoint`,
  );
  const { checkpoints } = await c.call('run.checkpoints', { runId: code.runId });
  const back = await c.call('run.restore', { runId: code.runId, ref: checkpoints.at(-1).ref });
  check(back.restored, `restored "${checkpoints.at(-1).label}": the last patch is rolled back`);
  console.log(`$ git status --short -uall\n${git('status', '--short', '-uall').stdout}`);

  const stats = await c.call('stats', {});
  const m = stats.metrics ?? stats;
  metrics.router = m.routerLatencyMs;
  metrics.fallbackRate = m.fallbackRate;
} finally {
  c.close();
}
await studio.stop();

say('`kpai bench`: a short calibration on this repository; it asks once before spending');
const cli = (...args) =>
  spawnSync(process.execPath, [bin, ...args], { cwd: repo, env, encoding: 'utf8' });
const tree = () => git('status', '--porcelain').stdout;
const before = tree();
const bench = cli('bench', '--allow-test', '--per-kind', '1');
process.stdout.write(
  `$ kpai bench --allow-test --per-kind 1   (no terminal to answer)\n${bench.stdout.replace(/^/gm, '  ')}`,
);
check(bench.status === 4, 'no human at the prompt: declined, nothing spent (exit 4)');
// The same bench through the kernel, with a human who says yes to its one question.
// The workspace exactly as `kpai studio` saw it (process.cwd(): a real path on macOS, where
// the temp folder is a symlink), so both write the same project in the journal.
const opened = Journal.open(join(home, 'journal.db'));
const project = opened.sessions(1000).find((x) => x.eventCount > 0)?.cwd ?? repo;
opened.close();
const asked = [];
const kernel = new Kernel({
  env,
  cwd: project,
  say: () => {},
  confirm: async (q) => (
    asked.push(q.question),
    q.kind === 'budget' && /^Bench: /.test(q.question)
  ),
});
const report = await kernel.learning.bench({ perKind: 1, options: { allowTest: true } });
await kernel.close();
console.log(`  asked once: ${asked[0]}`);
for (const line of report.summary) console.log(`  ${line}`);
for (const ch of report.changes)
  console.log(
    `  competence ${ch.ref} ${ch.taskType}: ${ch.before ? ch.before.score.toFixed(2) : 'none'} → ${ch.after.score.toFixed(2)} (${ch.after.samples})`,
  );
check(
  report.ran && asked.length === 1,
  `the bench ran ${report.tasks.length} task(s) after one yes`,
);
check(tree() === before, 'the bench wrote nothing to the repository');

say('`kpai memory list --layer project`: Markdown facts with provenance');
const list = cli('memory', 'list', '--layer', 'project');
process.stdout.write(list.stdout.replace(/^/gm, '  '));
check(
  /Deploy with make release/.test(list.stdout) && /local-only/.test(list.stdout),
  'the confirmed and the local-only facts are listed',
);

say('`kpai stats`: accuracy (R-402) and measured competence, from the journal');
const st = cli('stats');
process.stdout.write(st.stdout.replace(/^/gm, '  '));
check(
  st.status === 0 && /estimate accuracy here/.test(st.stdout),
  'kpai stats shows estimate accuracy',
);

say('Productivity (R-406), from the journal only (formulas: docs/metrics/PRODUCTIVITY.md)');
const j = Journal.open(join(home, 'journal.db'));
const p = productivity(j, { project });
console.log(`  runs ${p.runs} · spent ${usd(p.spentUsd)} · changes ${JSON.stringify(p.changes)}`);
console.log(
  `  cost per accepted change ${usd(p.costPerAcceptedChangeUsd ?? 0)} · time per accepted change ${p.timePerAcceptedChangeMs} ms`,
);
console.log(
  `  rollback rate ${pct(p.rollbackRate)} · rework rate ${pct(p.reworkRate)} · findings accepted ${p.review.acceptedFindings} (review ${usd(p.review.reviewUsd)}) · band hit ${p.band.inBand}/${p.band.runs}`,
);
check(p.changes.accepted === 2 && p.rolledBack === 1, 'two accepted changes, one rolled back');
check(
  p.review.acceptedFindings > 0,
  `${p.review.acceptedFindings} review findings led to an approved revision`,
);
const n = j.events({ limit: 100_000 }).length;
const s0 = performance.now();
CompetenceStore.fromJournal(j, { project });
const storeMs = performance.now() - s0;
j.close();

say('Phase 4 measurements (offline mocks)');
const ms3 = (x) => (typeof x === 'number' ? `${x.toFixed(3)} ms` : 'n/a');
console.log(
  `  router decision latency p50 ${ms3(metrics.router?.p50)} · p95 ${ms3(metrics.router?.p95)} (${metrics.router?.samples} decisions, measured store in force)`,
);
console.log(
  `  competence store rebuilt from ${n} events in ${storeMs.toFixed(1)} ms; a whole plan with it: ${metrics.planMsWithStore.toFixed(1)} ms`,
);
console.log(
  `  estimate band hit rate ${p.band.inBand}/${p.band.runs} (${pct(p.band.rate)}) · fallback rate ${metrics.fallbackRate}`,
);
console.log(
  `  memory injection ${metrics.memoryTokensPerNode} tokens per node × ${metrics.memoryNodes} nodes`,
);
console.log(
  `  replay ${usd(metrics.replay.replay)} vs original ${usd(metrics.replay.original)} · fork ${usd(metrics.fork.fork)} vs parent ${usd(metrics.fork.parent)} (cap ${usd(metrics.fork.cap)})`,
);

console.log(
  state.failures === 0
    ? '\n\x1b[32mDemo passed.\x1b[0m'
    : `\n\x1b[31m${state.failures} check(s) failed.\x1b[0m`,
);
process.exitCode = state.failures === 0 ? 0 : 1;
