/**
 * `kpai serve --headless` as a real child process (R-507, ADR-0035 §4): started, a program
 * enqueued through the CLI, the daemon killed with SIGKILL mid-run, then restarted. Asserts
 * from the files and the journal it left: nothing started twice, the cut run is settled
 * once with the cost its session really spent (no double spend), and the program resumes
 * to its gate. Needs the built CLI (`pnpm build`, which `pnpm check` runs first). Offline:
 * mock providers, loopback only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BIN,
  childWorld,
  kpaiChild as kpai,
  readJournal as journal,
  removeWorld,
  requireBuild,
  type ChildWorld as World,
} from './test-helpers/child.js';

// `[[slow]]` makes each mock answer stream word by word: a run lasts long enough to be cut.
const GOAL = [
  'OAuth login in two parts:',
  '- add an OAuth state validator with tests [[slow]] [[diff:src/state.ts]]',
  '- add a token parser with tests [[slow]] [[diff:src/token.ts]]',
].join('\n');

interface RunRow {
  runId: string;
  wpId: string;
  purpose: string;
  status: string;
  costUsd: number;
  evidence: string[];
}

const children: ChildProcess[] = [];
const worlds: World[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  for (const w of worlds.splice(0)) removeWorld(w);
});

function world(): World {
  const w = childWorld();
  worlds.push(w);
  writeFileSync(
    join(w.home, 'enterprise', 'portfolio.json'),
    JSON.stringify({ tickMs: 100, heartbeatSec: 5 }),
  );
  return w;
}

/** Starts the daemon; resolves once it printed its loopback URL. */
function serve(w: World): Promise<ChildProcess> {
  const child = spawn(process.execPath, [BIN, 'serve', '--headless', '--allow-test'], {
    cwd: w.repo,
    env: w.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stderr?.on('data', (c: Buffer) => (err += c.toString()));
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(`no daemon URL:\n${err}`)), 30_000);
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
      if (!/daemon on http:\/\/127\.0\.0\.1:\d+/.test(out)) return;
      clearTimeout(guard);
      resolve(child);
    });
    child.on('exit', (code) => reject(new Error(`kpai serve exited (${code}):\n${err}`)));
  });
}

function kill9(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

interface State {
  status: string;
  runs: RunRow[];
  escalations: Array<{ rule: string }>;
}

function state(w: World, id: string): State {
  return JSON.parse(readFileSync(join(w.home, 'programs', id, 'state.json'), 'utf8')) as State;
}

async function until<T>(read: () => T, ok: (x: T) => boolean, what: string, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    const x = read();
    if (ok(x)) return x;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(x)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function sessionOf(w: World, programId: string, runId: string): string {
  const meta = JSON.parse(readFileSync(join(w.home, 'programs', programId, 'meta.json'), 'utf8'));
  return (meta as { runs: Record<string, { sessionId: string }> }).runs[runId]!.sessionId;
}

describe('kpai serve --headless survives kill -9 (R-507)', () => {
  it('settles the cut run once, spends nothing twice and resumes the program', async () => {
    requireBuild();
    const w = world();
    let daemon = await serve(w);
    // Enqueued through the CLI while the daemon runs: draft, then approve the exact hash.
    const draft = kpai(w, 'program', 'new', GOAL, '--budget', '20', '--allow-test');
    expect(draft.status, draft.stderr).toBe(0);
    const id = /program (prog-[0-9a-f]+)/.exec(draft.stdout)![1]!;
    const hash = /charter ([0-9a-f]{64})/.exec(draft.stdout)![1]!;
    expect(kpai(w, 'program', 'approve', id, hash).status).toBe(0);
    const cut = await until(
      () => state(w, id),
      (s) => s.runs.some((r) => r.status === 'running'),
      'a running work package',
    );
    await kill9(daemon);
    const live = state(w, id).runs.filter((r) => r.status === 'running');
    expect(live.length).toBeGreaterThan(0);
    // What each cut run's session had really spent when the process died.
    const spentAtKill = new Map(
      live.map((r) => [
        r.runId,
        journal(w, (j) => j.spend({ sessionId: sessionOf(w, id, r.runId) })),
      ]),
    );
    expect(cut.runs.length).toBeGreaterThan(0);

    daemon = await serve(w);
    const s = await until(
      () => state(w, id),
      (x) => x.escalations.some((e) => e.rule === 'gate.pass'),
      'the gate question after the restart',
    );
    await kill9(daemon);

    const ids = s.runs.map((r) => r.runId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of live) {
      const settled = s.runs.find((x) => x.runId === r.runId)!;
      expect(settled.status).toBe('cancelled');
      expect(settled.evidence).toContain('interrupted:restart');
      const sid = sessionOf(w, id, r.runId);
      // No double spend: the cut session spent nothing more, and that cost is counted once.
      expect(journal(w, (j) => j.spend({ sessionId: sid }))).toBeCloseTo(
        spentAtKill.get(r.runId)!,
        9,
      );
      expect(settled.costUsd).toBeCloseTo(spentAtKill.get(r.runId)!, 6);
    }
    // Resumed: each work package finished exactly once, then the review ran.
    const finished = s.runs.filter((r) => r.purpose === 'work' && r.status === 'finished');
    expect(finished.map((r) => r.wpId).sort()).toEqual(['wp1', 'wp2']);
    expect(s.runs.some((r) => r.purpose === 'review' && r.status === 'finished')).toBe(true);
    // The queue's settled spend is the sum of the runs' costs: nothing counted twice.
    const queue = JSON.parse(readFileSync(join(w.home, 'enterprise', 'queue.json'), 'utf8'));
    const total = s.runs.reduce((a, r) => a + r.costUsd, 0);
    expect((queue as { spentUsd: number }).spentUsd).toBeCloseTo(total, 6);
    // The journal: one outcome per finished run, none for a cut one, which was settled instead.
    const facts = journal(w, (j) => j.events({ limit: 100_000 }).map((e) => e.payload));
    const outcomes = facts.filter((p) => p['action'] === 'run outcome').map((p) => p['runId']);
    expect(new Set(outcomes).size).toBe(outcomes.length);
    for (const r of live) {
      expect(outcomes).not.toContain(r.runId);
      const interrupted = facts.filter(
        (p) => p['action'] === 'run interrupted' && p['runId'] === r.runId,
      );
      expect(interrupted).toHaveLength(1);
    }
    // The north star reads it: a cut but settled run is not a silent failure.
    const ns = kpai(w, 'stats', '--north-star');
    expect(ns.status, ns.stderr).toBe(0);
    expect(ns.stdout).toMatch(/G3 silent runs 0\/\d+ \(0%\)/);
    expect(ns.stdout).toMatch(/G5 safety invariants: 0 \(ok\)/);
  }, 180_000);
});
