/**
 * Daemon safety properties with a fake kernel side (ADR-0035): D-029 R1 (no subscription
 * agent unattended), S10 R3 (spend-rate cap, progress-gated burn, expiry), the kill switch,
 * one daemon per home, and restart recovery that never re-spends silently.
 */
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cancelling, fakeStarter, FINISHED, type Fake } from './test-helpers/fake.js';
import { world, type World } from './test-helpers/world.js';

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

/** A drafted, approved program of two work packages; returns its id. */
async function approved(x: World, budgetUsd = 10, goal = 'Two parts:\n- one\n- two') {
  const d = await x.rt.create({ goal, budgetUsd, critic: false });
  await x.rt.sponsor.act(d.programId, { type: 'approve', charterHash: d.charterHash });
  return d.programId;
}

async function tick(x: World, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await x.rt.daemon.tick();
    await new Promise((r) => setTimeout(r, 5));
  }
}

const status = (x: World, id: string) => x.rt.get(id).status;

describe('unattended means narrower (D-029 R1)', () => {
  it('never starts a run planned on a subscription agent', async () => {
    w = world();
    const fake = fakeStarter(w.rt);
    fake.figures = { capUsd: 1, providers: ['anthropic'], source: 'subscription' };
    const id = await approved(w);
    await tick(w, 3);
    expect(fake.runs).toHaveLength(0);
    expect(w.rt.store.queue().pending).toHaveLength(0);
    expect(w.rt.activity().items.some((a) => /interactively \(D-029 R1\)/.test(a.text))).toBe(true);
    expect(status(w, id)).toBe('running');
  });
});

describe('spend-rate cap (S10 R3)', () => {
  it('holds a start that would pass the $/hour cap', async () => {
    w = world();
    const fake = fakeStarter(w.rt);
    w.config({ usdPerHour: 1.5 });
    await approved(w);
    await tick(w, 2);
    // Two band tops of $1 would make $2 in the hour: only one starts.
    expect(fake.runs).toHaveLength(1);
    expect(w.rt.activity().items.some((a) => /spend rate/.test(a.text))).toBe(true);
    fake.runs.forEach((r) => r.finish());
  });
});

describe('progress-gated burn (S10 R3)', () => {
  it('pauses at a quarter of the phase cap with no verified result, until the Sponsor says go', async () => {
    w = world();
    const fake = fakeStarter(w.rt);
    const id = await approved(w, 4);
    await tick(w);
    expect(fake.runs).toHaveLength(2);
    // The first run settles at $1 (a quarter of $4), unverified (V0: no journal facts).
    const run = fake.runs[0]!;
    const spent = { ...FINISHED, result: { ...FINISHED.result, ok: false } };
    run.finish(spent);
    await w.rt.idle();
    // Cost is read from the journal session: give it one.
    await w.rt.store.locked(() => {
      const s = w!.rt.store.read(id).state;
      const r = s.runs.find((x) => x.runId === run.runId)!;
      w!.rt.store.writeState(id, {
        ...s,
        runs: s.runs.map((x) => (x === r ? { ...r, costUsd: 1 } : x)),
      });
    });
    await tick(w);
    expect(status(w, id)).toBe('paused');
    const q = w.rt.get(id).escalations.find((e) => e.rule === 'progress.none')!;
    expect(q.question).toMatch(/25% of the p1 cap/);
    // Consequential: the evidence first, then the yes; the program resumes.
    await expect(w.rt.sponsor.answer(id, q.id, 'yes')).rejects.toThrow(/evidence first/);
    await w.rt.sponsor.viewed(id, { kind: 'escalation', id: q.id }, q.id);
    await w.rt.sponsor.answer(id, q.id, 'yes');
    await tick(w);
    expect(status(w, id)).toBe('running');
    expect(w.rt.get(id).meta.progressAck).toEqual({ p1: 1 });
    fake.runs.forEach((r) => r.finish());
  });
});

describe('envelope expiry (S10 R3)', () => {
  it('pauses an expired program and renews it only on the Sponsor’s yes', async () => {
    w = world();
    let now = new Date();
    w.rt.ctx.clock = () => now;
    const fake = fakeStarter(w.rt);
    const id = await approved(w);
    expect(w.rt.get(id).charter.envelope.expires).toBeDefined();
    now = new Date(now.getTime() + 15 * 86_400_000);
    await tick(w);
    expect(status(w, id)).toBe('paused');
    const q = w.rt.get(id).escalations.find((e) => e.rule === 'envelope.expired')!;
    await w.rt.sponsor.viewed(id, { kind: 'escalation', id: q.id }, q.id);
    await w.rt.sponsor.answer(id, q.id, 'yes');
    await tick(w);
    const s = w.rt.get(id);
    expect(s.status).toBe('running');
    expect(Date.parse(s.charter.envelope.expires!)).toBeGreaterThan(now.getTime());
    expect(s.charterHash).toBe(s.approval!.charterHash);
    fake.runs.forEach((r) => r.finish());
  });
});

describe('kill switch and the daemon slot', () => {
  it('cancels live runs and starts nothing while on', async () => {
    w = world();
    const fake = fakeStarter(w.rt);
    const id = await approved(w);
    await tick(w);
    expect(fake.runs).toHaveLength(2);
    const cancel = cancelling(w, fake);
    const cancelled = await w.rt.daemon.kill(true);
    expect(w.rt.snapshot().killSwitch).toBe(true);
    // Every live run is cancelled through the kernel, and settles cancelled.
    const ids = fake.runs.map((r) => r.runId);
    expect(cancelled.sort()).toEqual([...ids].sort());
    expect(cancel.mock.calls.map(([id]) => id).sort()).toEqual([...ids].sort());
    await w.rt.idle();
    expect(w.rt.ctx.live.size).toBe(0);
    expect(w.rt.get(id).runs.map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
    await tick(w, 2);
    expect(fake.runs).toHaveLength(2);
    expect(cancel).toHaveBeenCalledTimes(2);
    await w.rt.daemon.kill(false);
    await tick(w);
    expect(fake.runs.length).toBeGreaterThan(2);
    fake.runs.forEach((r) => r.finish());
  });

  it('one daemon per home: a live owner keeps the slot', async () => {
    w = world();
    writeFileSync(w.rt.store.path('daemon.pid'), String(process.ppid));
    expect(await w.rt.daemon.start()).toBe(false);
    expect(w.rt.daemon.running).toBe(false);
    writeFileSync(w.rt.store.path('daemon.pid'), '999999999');
    expect(await w.rt.daemon.start()).toBe(true);
    expect(w.rt.heartbeat().status).toBe('ok');
  });
});

describe('restart (R-507, R-5E4)', () => {
  it('settles an interrupted run with its cost and plans the work package again, once', async () => {
    w = world();
    const fake: Fake = fakeStarter(w.rt);
    const id = await approved(w);
    await tick(w);
    const cut = fake.runs[0]!;
    // The process dies: a new runtime over the same home starts the daemon.
    const host = w.host;
    await w.rt.daemon.stop();
    const again = world({}, host);
    const fake2 = fakeStarter(again.rt);
    expect(await again.rt.daemon.start()).toBe(true);
    const run = again.rt.get(id).runs.find((r) => r.runId === cut.runId)!;
    expect(run.status).toBe('cancelled');
    expect(run.evidence).toContain('interrupted:restart');
    expect(again.rt.store.queue().running).toHaveLength(0);
    await again.rt.daemon.tick();
    await again.rt.idle();
    // Both work packages run again under new run ids; nothing started twice.
    const ids = again.rt.get(id).runs.map((r) => r.runId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(fake2.runs.map((r) => r.wpId).sort()).toEqual(['wp1', 'wp2']);
    expect(again.rt.activity().items.some((a) => /interrupted by a restart/.test(a.text))).toBe(
      true,
    );
    fake2.runs.forEach((r) => r.finish());
    fake.runs.forEach((r) => r.finish());
    await again.rt.close();
  });
});
