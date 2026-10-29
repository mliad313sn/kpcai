#!/usr/bin/env node
// Phase 5 reproducible demo: Enterprise mode, offline. Four mock providers in a throwaway
// git repository. A goal becomes a charter (one small team, a cross-provider critic, the
// "one run" baseline); the Sponsor approves its hash; `kpai serve --headless` runs the two
// work packages unattended; the daemon is killed mid-run and restarted (the interrupted
// run is settled and planned again, nothing starts twice); the gate question is answered
// after its evidence is opened; the final report carries assurance labels. No API key is
// read from the shell; the daemon listens on 127.0.0.1 only.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectRpc } from './lib/studio-client.mjs';
import { checker, demoWorld, say } from './lib/demo4-setup.mjs';

const root = new URL('../', import.meta.url);
const bin = fileURLToPath(new URL('apps/cli/dist/bin.js', root));
const { EnterpriseSnapshotSchema } = await import(
  new URL('packages/kernel/dist/protocol.js', root).href
);

const { home, repo, env } = demoWorld();
const { state, check } = checker();
const GOAL = [
  'OAuth login in two parts:',
  '- add an OAuth state validator with tests [[diff:src/state.ts]] [[testdiff:test/state.test.ts]]',
  '- add a token parser with tests [[diff:src/token.ts]] [[testdiff:test/token.test.ts]]',
].join('\n');

const kpai = (...args) =>
  spawnSync(process.execPath, [bin, ...args], { cwd: repo, env, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts `kpai serve --headless`; resolves with its port, token and a kill switch. */
function serve() {
  const child = spawn(process.execPath, [bin, 'serve', '--headless', '--allow-test'], {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(`no daemon URL:\n${err}`)), 20_000);
    child.stdout.on('data', (c) => {
      out += c;
      const m = /daemon on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (!m) return;
      clearTimeout(guard);
      const { token } = JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'));
      resolve({
        port: Number(m[1]),
        token,
        crash: async () => (child.kill('SIGKILL'), exited),
        stop: async () => (child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGINT'), exited),
      });
    });
    child.on('exit', (code) => reject(new Error(`kpai serve exited (${code}):\n${err}`)));
  });
}

async function until(c, id, pred, what, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const s = await c.call('program.get', { programId: id });
    if (pred(s)) return s;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (status ${s.status})`);
    await sleep(150);
  }
}

console.log(`KernelPAI phase 5 demo — Enterprise mode — repo ${repo}`);
mkdirSync(join(home, 'enterprise'), { recursive: true });
writeFileSync(
  join(home, 'enterprise', 'portfolio.json'),
  JSON.stringify({ tickMs: 200, heartbeatSec: 5 }),
);

say(
  'Goal → charter: one small team, a critic on another provider, the one-run baseline (S10 R7, R10)',
);
const draft = kpai('program', 'new', GOAL, '--budget', '20', '--allow-test');
process.stdout.write(draft.stdout.replace(/^/gm, '  '));
const programId = /program (prog-[0-9a-f]+)/.exec(draft.stdout)?.[1];
const hash = /charter ([0-9a-f]{64})/.exec(draft.stdout)?.[1];
check(draft.status === 0 && !!programId && !!hash, 'charter drafted, bound to a hash');
check(
  /team: Builder, Independent reviewer/.test(draft.stdout),
  'default team: builder and independent reviewer, no departments',
);
check(
  /critique \(done, mock/.test(draft.stdout),
  'the charter critic ran on a provider the builders do not use',
);
check(
  /as one run: likely \$/.test(draft.stdout),
  'the "do it as one run" baseline is shown next to the cap',
);

say('The Sponsor approves the exact charter; the daemon runs it headless');
check(
  kpai('program', 'approve', programId, 'f'.repeat(64)).status !== 0,
  'a wrong hash approves nothing',
);
check(kpai('program', 'approve', programId, hash).status === 0, 'approved by hash');
let d = await serve();
let c = await connectRpc(d.port, d.token);
await c.waitFor(
  (n) => n.method === 'enterprise.wp' && n.params.state === 'running',
  30_000,
  'a run',
);
check(true, 'a work package started unattended in its own worktree');

say('Crash and restart (R-507): the daemon is killed mid-run');
c.close?.();
await d.crash();
const cut = JSON.parse(readFileSync(join(home, 'programs', programId, 'state.json'), 'utf8'));
const live = cut.runs.filter((r) => r.status === 'running').map((r) => r.runId);
console.log(`  runs live at the crash: ${live.length}`);
d = await serve();
c = await connectRpc(d.port, d.token);
let s = await until(
  c,
  programId,
  (x) => x.escalations.some((e) => e.rule === 'gate.pass'),
  'the gate question',
);
const ids = s.runs.map((r) => r.runId);
check(new Set(ids).size === ids.length, `no run started twice (${ids.length} runs)`);
check(
  live.every((id) => s.runs.find((r) => r.runId === id)?.evidence.includes('interrupted:restart')),
  'every run cut by the crash is settled "interrupted", its cost counted, then planned again',
);
const work = s.runs.filter((r) => r.purpose === 'work' && r.status === 'finished');
check(work.length === 2, 'both work packages finished after the restart');

say('One question for the Sponsor (S10 R8): the gate, answered after opening its evidence');
const gate = s.escalations.find((e) => e.rule === 'gate.pass');
console.log(`  > ${gate.question}`);
const blind = await c
  .call('program.answer', { programId, escalationId: gate.id, answer: 'yes' })
  .catch((e) => e);
check(
  /evidence first/.test(blind.message ?? ''),
  'a consequential yes is refused before the evidence is opened',
);
const review = s.runs.find((r) => r.purpose === 'review');
await c.call('program.viewed', {
  programId,
  escalationId: gate.id,
  ref: { kind: 'run', id: review.runId },
});
await sleep(3_100); // a considered answer, not a rubber stamp
await c.call('program.answer', { programId, escalationId: gate.id, answer: 'yes' });
s = await until(c, programId, (x) => x.status === 'delivered', 'delivery');
check(
  s.gates[0]?.verdict === 'pass',
  `gate passed; the reviewer ran on ${review.providers.join(', ')}, no builder's provider`,
);

say('Report with assurance labels (S10 R5)');
const { reports } = await c.call('program.reports', { programId });
const final = reports.find((r) => r.kind === 'final');
const results = final.markdown.split('## Results and assurance')[1] ?? '';
process.stdout.write(results.trim().replace(/^/gm, '  ') + '\n');
check(
  /wp1 finished — V[123]/.test(results) && /wp2 finished — V[123]/.test(results),
  'each delivered result carries its label and what earned it',
);
check(
  final.verified === false && /Not verified/.test(final.markdown),
  'no CI for the exact commit: "Delivered. Not verified", never ticked silently',
);

say('Snapshot, heartbeat and dead-man (S10 R2)');
const snap = EnterpriseSnapshotSchema.safeParse(await c.call('enterprise.snapshot', {}));
check(snap.success, 'enterprise.snapshot matches the protocol schema');
check(
  snap.data?.rubberStamp?.rate === 0,
  `rubber-stamp rate ${snap.data?.rubberStamp?.rate} over ${snap.data?.rubberStamp?.consequential} consequential approval(s)`,
);
const hb = await fetch(`http://127.0.0.1:${d.port}/enterprise/heartbeat`);
check(hb.status === 200, `GET /enterprise/heartbeat → ${hb.status} (${(await hb.json()).status})`);
check(
  kpai('program', 'heartbeat', '--check').status === 0,
  'kpai program heartbeat --check: fresh',
);
say('North star from the journal only (S10, docs/metrics/NORTH-STAR.md)');
const ns = kpai('stats', '--north-star');
const block = ns.stdout.slice(ns.stdout.indexOf('north star here'));
process.stdout.write(block.split('\n').slice(0, 14).join('\n').replace(/^/gm, '  ') + '\n');
check(ns.status === 0 && /north star here/.test(ns.stdout), 'kpai stats --north-star runs');
check(
  /G3 silent runs 0\/\d+ \(0%\)/.test(ns.stdout),
  'the run cut by the crash was settled, not left silent (G3)',
);
check(/G5 safety invariants: 0 \(ok\)/.test(ns.stdout), 'safety invariants at 0 (G5)');
check(
  /rubber-stamped 0\/1 \(0%\)/.test(ns.stdout),
  'the gate yes came 3 s after its evidence was opened: not a rubber stamp (G2)',
);
c.close?.();
const code = await d.stop();
console.log(`  daemon stopped (${code})`);

console.log(state.failures ? `\n${state.failures} check(s) failed` : '\nAll checks passed.');
process.exit(state.failures ? 1 : 0);
