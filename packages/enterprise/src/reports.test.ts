/**
 * R-5E8 / S10 R4 on the runtime (ADR-0036): gate reports in the fixed order with journal
 * sequences, milestone reports, change-only digests at the cadence (an unchanged period is
 * a heartbeat entry, not a digest), French reports, and alerts and dead-man staleness that
 * reach the channels.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { charterHash } from '@kernelpai/program';
import { HEARTBEAT_FILE } from './liveness.js';
import { execInput, journalMetrics, maybeDigest } from './period.js';
import { fakeStarter, type Fake } from './test-helpers/fake.js';
import { world, type World } from './test-helpers/world.js';

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const HOUR = 3_600_000;

/** A world whose clock the test moves; returns the setter. */
function clocked(x: World): (h: number) => void {
  let now = new Date();
  x.rt.ctx.clock = () => now;
  return (h) => void (now = new Date(now.getTime() + h * HOUR));
}

async function approved(x: World, locale?: 'fr'): Promise<string> {
  const d = await x.rt.create({
    goal: 'Two parts:\n- one\n- two',
    budgetUsd: 10,
    critic: false,
    ...(locale ? { locale } : {}),
  });
  await x.rt.sponsor.act(d.programId, { type: 'approve', charterHash: d.charterHash });
  return d.programId;
}

async function settle(x: World, fake: Fake): Promise<void> {
  fake.runs.forEach((r) => r.finish());
  await x.rt.idle();
}

const facts = (x: World, action: string) =>
  x.kernel
    .sessions(50)
    .flatMap((s) => x.kernel.events(s.id, 1_000))
    .filter((e) => e.payload['action'] === action);

const notices = (x: World): string => {
  const p = x.rt.store.path('notifications.md');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

describe('gate and milestone reports', () => {
  it('writes the gate report asks first, citing log sequences, and notifies the local channel', async () => {
    w = world();
    const fake = fakeStarter(w.rt);
    const id = await approved(w);
    await w.rt.daemon.tick();
    await settle(w, fake);
    await w.until(() => w!.rt.get(id).status === 'gate');
    const gate = w.rt.reports(id).find((r) => r.kind === 'gate')!;
    const md = gate.markdown;
    const order = [
      'What needs your answer',
      'What changed',
      'Forecast',
      'Top risk',
      'Results and assurance',
    ];
    const at = order.map((h) => md.indexOf(`## ${h}`));
    expect(at.every((x) => x > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(md).toMatch(/wp\d: finished, V0 .*_\(event:\d+, run:run-\d+/);
    expect(md).toMatch(/phase p1 reached its gate _\(event:\d+\)_/);
    expect(md).toMatch(/spend at completion \$/);
    const seq = w.rt.get(id).meta.reportSeq!;
    expect(w.rt.history(id).entries[seq - 1]).toMatchObject({ type: 'reported', ok: true });
    await w.rt.idle();
    expect(notices(w)).toContain(`${id}: gate report`);
    expect(notices(w)).not.toMatch(/one|two/);
    expect(facts(w, 'notification sent').map((e) => e.payload['channel'])).toContain('markdown');
  });

  it('writes a milestone report when a gate passes and work goes on', async () => {
    w = world();
    const fake = fakeStarter(w.rt);
    const d = await w.rt.create({ goal: 'Two parts:\n- one\n- two', budgetUsd: 10, critic: false });
    const id = d.programId;
    // Two phases, one work package each, before the Sponsor approves the charter's hash.
    const s = w.rt.store.read(id).state;
    const [p1] = s.charter.phases;
    const charter = {
      ...s.charter,
      phases: [
        { ...p1!, capUsd: 5, workPackages: [p1!.workPackages[0]!] },
        { ...p1!, id: 'p2', capUsd: 5, workPackages: [p1!.workPackages[1]!] },
      ],
    };
    await w.rt.store.locked(() => w!.rt.store.writeState(id, { ...s, charter }));
    // The gate review must run on another provider than the builders'.
    const plan = fake.plan.bind(fake);
    fake.plan = (input) => {
      fake.figures.providers = [input.purpose === 'review' ? 'mock-delta' : 'mock-beta'];
      return plan(input);
    };
    await w.rt.sponsor.act(id, { type: 'approve', charterHash: charterHash(charter) });
    await w.until(() => {
      fake.runs.forEach((r) => r.finish());
      return w!.rt.get(id).escalations.some((e) => e.rule === 'gate.pass');
    });
    const q = w.rt.get(id).escalations.find((e) => e.rule === 'gate.pass')!;
    const review = w.rt.get(id).runs.find((r) => r.purpose === 'review')!;
    await w.rt.sponsor.viewed(id, { kind: 'run', id: review.runId }, q.id);
    await w.rt.sponsor.answer(id, q.id, 'yes');
    await w.until(() => w!.rt.reports(id).some((r) => r.kind === 'milestone'));
    const ms = w.rt.reports(id).find((r) => r.kind === 'milestone')!.markdown;
    expect(ms).toMatch(/gate p1: pass/);
    expect(ms).toMatch(/you answered yes to esc-/);
    fake.runs.forEach((r) => r.finish());
  });
});

describe('change-only digests at the cadence (Q-8, S10 R4 b)', () => {
  it('sends a digest when something changed, and only a heartbeat entry when nothing did', async () => {
    w = world();
    const move = clocked(w);
    const fake = fakeStarter(w.rt);
    const id = await approved(w);
    await w.rt.daemon.tick();
    await settle(w, fake);
    await w.rt.sponsor.act(id, { type: 'pause' });
    // Daily by default: nothing is due before 24 h.
    move(23);
    expect(await w.rt.store.locked(() => maybeDigest(w!.rt.ctx, id, w!.rt.ctx.clock()))).toBe(
      'not-due',
    );
    move(2);
    await w.rt.daemon.tick();
    await w.rt.idle();
    const digests = () => w!.rt.reports(id).filter((r) => r.kind === 'digest');
    expect(digests()).toHaveLength(1);
    const md = digests()[0]!.markdown;
    expect(md).toMatch(/the program started _\(event:\d+\)_/);
    expect(md).toMatch(/pause by sponsor/);
    expect(md).not.toContain('## Results');
    // Another day with no change: no digest, a journaled heartbeat entry, the cadence restarts.
    move(25);
    await w.rt.daemon.tick();
    await w.rt.idle();
    expect(digests()).toHaveLength(1);
    expect(facts(w, 'digest skipped: no change')).toHaveLength(1);
    expect(w.rt.activity().items.some((a) => /: no digest$/.test(a.text))).toBe(true);
    expect(Date.parse(w.rt.get(id).lastReportAt!)).toBe(w.rt.ctx.clock().getTime());
    // A change again: the next digest covers only what is new.
    await w.rt.sponsor.act(id, { type: 'resume' });
    await w.rt.sponsor.act(id, { type: 'pause' });
    move(25);
    await w.rt.daemon.tick();
    await w.rt.idle();
    expect(digests()).toHaveLength(2);
    const next = digests()[1]!.markdown;
    expect(next).toMatch(/resume by sponsor/);
    expect(next).not.toMatch(/the program started|wp\d: finished/);
  });

  it('writes reports in the charter language', async () => {
    w = world();
    const move = clocked(w);
    fakeStarter(w.rt);
    const id = await approved(w, 'fr');
    await w.rt.daemon.tick();
    move(25);
    await w.rt.daemon.tick();
    const md = w.rt.reports(id).find((r) => r.kind === 'digest')!.markdown;
    expect(md).toContain('## Ce qui attend votre réponse');
    expect(md).toContain('## Prévision');
    expect(md).toMatch(/le programme a démarré/);
  });
});

describe('alerts leave the machine too (S10 R2)', () => {
  it('notifies a new watchdog alert once, as rule ids', async () => {
    w = world();
    const move = clocked(w);
    w.config({ heartbeatSec: 1, watch: { runStallMinutes: 5 } });
    const fake = fakeStarter(w.rt);
    await approved(w);
    await w.rt.daemon.tick();
    move(0.2);
    await w.rt.daemon.tick();
    await w.rt.idle();
    move(0.001);
    await w.rt.daemon.tick();
    await w.rt.idle();
    const text = notices(w);
    expect(text.match(/watchdog alert/g)).toHaveLength(1);
    expect(text).toContain('1 alert: run.stalled.');
    fake.runs.forEach((r) => r.finish());
  });

  it('reports the dead-man staleness when the daemon comes back', async () => {
    w = world();
    const old = new Date(Date.now() - 3_600_000).toISOString();
    writeFileSync(
      w.rt.store.path(HEARTBEAT_FILE),
      JSON.stringify({
        at: old,
        pid: 1,
        intervalSec: 60,
        staleAfterSec: 180,
        status: 'ok',
        alerts: [],
        programs: 0,
        running: 0,
      }),
    );
    expect(await w.rt.daemon.start()).toBe(true);
    await w.rt.idle();
    expect(notices(w)).toContain(`silent since ${old}`);
  });
});

describe('what a report covers', () => {
  it('takes test evidence from the runs and silence deadlines from run questions', async () => {
    w = world();
    const id = await approved(w);
    const now = new Date();
    await w.rt.store.locked(() => {
      const s = w!.rt.store.read(id).state;
      const base = {
        phaseId: 'p1',
        capUsd: 1,
        costUsd: 0.1,
        purpose: 'work' as const,
        source: 'api' as const,
        hours: 0,
        providers: [],
        evidence: [],
        startedAt: now.toISOString(),
      };
      w!.rt.store.writeState(id, {
        ...s,
        status: 'running',
        runs: [
          { ...base, runId: 'ra', wpId: 'wp1', status: 'finished', testsPassed: true },
          { ...base, runId: 'rb', wpId: 'wp2', status: 'failed', testsPassed: false },
        ],
        escalations: [
          { id: 'esc-1', at: now.toISOString(), rule: 'confirm.write', question: 'Write?' },
        ],
      });
      w!.rt.store.updateMeta(
        id,
        (m) => void (m.escalations['esc-1'] = { kind: 'confirm', evidence: [] }),
      );
    });
    const { state, meta } = w.rt.store.read(id);
    expect(journalMetrics(state)).toEqual({
      tests: { passed: 1, failed: 1, evidence: ['run:ra', 'run:rb'] },
    });
    expect(journalMetrics({ ...state, runs: [] })).toEqual({});
    const input = execInput(w.rt.ctx, id, state, meta, now);
    expect(input.deadlines).toEqual({
      'esc-1': new Date(now.getTime() + 60 * 60_000).toISOString(),
    });
    // Only accepted transitions with an event: the creation line has none.
    expect(input.events.every((e) => e.seq > 1 && e.event !== undefined)).toBe(true);
  });
});
