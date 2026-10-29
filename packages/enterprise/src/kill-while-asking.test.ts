/**
 * P5-R1 (D-035): a kill or a stop reaches a question the run waits on. A real kernel run
 * waits on a Sponsor question (an in-envelope spend, not pre-answered). The kill switch
 * from another process (B) or a stop in this one (A) cancels the run: the gate's wait ends
 * as a no at once, the question expires in the store (journaled), the run settles
 * `cancelled` within one guard interval and a late yes is refused. A pause keeps the
 * question but takes no answer until the program runs again.
 *
 * `SLOW` makes the gate's own poll longer than any wait here, so only the guard (or the
 * kernel's cancel hook) can end the question; the default poll shows the gate's own check.
 */
import { afterEach, expect, it } from 'vitest';
import { GUARD_MS } from './guard.js';
import { world, type World } from './test-helpers/world.js';

const SLOW = 60_000;
const ASKING = { KPAI_CONFIRM_ABOVE_USD: '0' };

let a: World | undefined;
let b: World | undefined;
afterEach(async () => {
  await b?.close();
  await a?.close();
  a = b = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open = (x: World, id: string) => x.rt.get(id).escalations.filter((e) => !e.answer);

interface Asking {
  id: string;
  runId: string;
  q: { id: string };
}

/** A runs one work package that waits on a Sponsor question; its daemon started or not. */
async function asking(x: World, start = true): Promise<Asking> {
  if (start) expect(await x.rt.daemon.start()).toBe(true);
  const goal = 'One part:\n- add a token parser [[diff:src/b.ts]]';
  const d = await x.rt.create({ goal, budgetUsd: 10, critic: false });
  await x.rt.sponsor.act(d.programId, { type: 'approve', charterHash: d.charterHash });
  // Test set-up only: an envelope without pre-answers, so the run's first spend question waits.
  await x.rt.store.locked(() => {
    const st = x.rt.store.read(d.programId).state;
    const envelope = { ...st.charter.envelope, preAnswer: [] };
    x.rt.store.writeState(d.programId, { ...st, charter: { ...st.charter, envelope } });
  });
  for (let i = 0; i < 200 && !open(x, d.programId).length; i++) {
    await x.rt.daemon.tick();
    await sleep(20);
  }
  const [q] = open(x, d.programId);
  expect(q?.rule).toBe('confirm.budget');
  return { id: d.programId, runId: [...x.rt.ctx.live.keys()][0]!, q: q! };
}

/** Milliseconds until the program records the run as settled `cancelled` (or -1). */
async function settledIn(x: World, s: Asking, since: number, max = 1_500): Promise<number> {
  while (Date.now() - since < max) {
    const r = x.rt.get(s.id).runs.find((y) => y.runId === s.runId);
    if (r?.status === 'cancelled') return Date.now() - since;
    await sleep(5);
  }
  return -1;
}

async function expectSettled(x: World, s: Asking, since: number, within: number): Promise<void> {
  const ms = await settledIn(x, s, since);
  expect(ms).toBeGreaterThanOrEqual(0);
  expect(ms).toBeLessThan(within);
  expect(x.rt.ctx.live.has(s.runId)).toBe(false);
}

function expectExpired(x: World, s: Asking, why: string): void {
  expect(x.rt.get(s.id).meta.escalations[s.q.id]?.expired).toBe(true);
  expect(x.rt.snapshot().inbox.some((e) => e.escalationId === s.q.id)).toBe(false);
  const facts = x.kernel
    .events(x.rt.ctx.sessionOf(s.id), 10_000)
    .filter((e) => e.payload['action'] === 'question expired');
  expect(facts.map((e) => [e.payload['escalationId'], e.payload['why']])).toEqual([[s.q.id, why]]);
}

/** The Sponsor, in `x`, opens the question late and says yes: refused, nothing recorded. */
async function lateYesRefused(x: World, s: Asking): Promise<void> {
  await x.rt.sponsor.viewed(s.id, { kind: 'escalation', id: s.q.id }, s.q.id);
  await expect(x.rt.sponsor.answer(s.id, s.q.id, 'yes')).rejects.toThrow(/expired/);
  expect(x.rt.get(s.id).escalations.find((e) => e.id === s.q.id)?.answer).toBeUndefined();
}

it('a kill switch from another process ends the question: the run settles cancelled within one guard interval', async () => {
  a = world(ASKING, undefined, SLOW);
  const s = await asking(a);
  b = world({}, a.host);
  const t0 = Date.now();
  await b.rt.daemon.kill(true);
  // Only A's guard timer can act (A does not tick, its gate polls once a minute).
  await expectSettled(a, s, t0, GUARD_MS + 250);
  expectExpired(a, s, 'kill switch on');
  await lateYesRefused(b, s);
});

it('a stop in this process ends the question at once, as a no', async () => {
  a = world(ASKING, undefined, SLOW);
  const s = await asking(a);
  const t0 = Date.now();
  await a.rt.sponsor.stop(s.id, 'stop while asking');
  await expectSettled(a, s, t0, 250);
  expectExpired(a, s, 'program stopped');
  await lateYesRefused(a, s);
});

it('the gate’s own poll notices a kill switch with no guard running', async () => {
  a = world(ASKING);
  const s = await asking(a, false);
  b = world({}, a.host);
  await b.rt.daemon.kill(true);
  await expectSettled(a, s, Date.now(), 500);
  expectExpired(a, s, 'kill switch on');
  await lateYesRefused(b, s);
});

it('the gate’s own poll notices a program stopped from another process', async () => {
  a = world(ASKING);
  const s = await asking(a, false);
  b = world({}, a.host);
  await b.rt.sponsor.stop(s.id, 'stop from the console');
  await expectSettled(a, s, Date.now(), 500);
  expectExpired(a, s, 'program stopped');
  await lateYesRefused(b, s);
});

it('the gate’s own poll notices a run the kernel cancelled', async () => {
  a = world(ASKING);
  const s = await asking(a, false);
  expect(a.kernel.cancel(s.runId)).toBe(true);
  await expectSettled(a, s, Date.now(), 500);
  expectExpired(a, s, 'run cancelled');
});

it('the kernel’s cancel hook ends the question at once', async () => {
  a = world(ASKING, undefined, SLOW);
  const s = await asking(a, false);
  a.kernel.cancel(s.runId);
  a.rt.cancelConfirmations(s.runId);
  await expectSettled(a, s, Date.now(), 250);
  expectExpired(a, s, 'run cancelled');
});

it('a pause keeps the question but takes no answer until the program runs again', async () => {
  a = world(ASKING);
  const s = await asking(a);
  await a.rt.sponsor.act(s.id, { type: 'pause' });
  await sleep(GUARD_MS);
  await a.rt.sponsor.viewed(s.id, { kind: 'escalation', id: s.q.id }, s.q.id);
  await expect(a.rt.sponsor.answer(s.id, s.q.id, 'yes')).rejects.toThrow(/paused/);
  expect(a.rt.get(s.id).meta.escalations[s.q.id]?.expired).toBeUndefined();
  expect(a.rt.get(s.id).runs.find((r) => r.runId === s.runId)?.status).toBe('running');
  await a.rt.sponsor.act(s.id, { type: 'resume' });
  await a.rt.sponsor.answer(s.id, s.q.id, 'yes');
  expect(a.rt.get(s.id).escalations.find((e) => e.id === s.q.id)?.answer).toBe('yes');
});

it('before any guard acts, a kill switch already refuses the answer and new questions', async () => {
  a = world(ASKING, undefined, SLOW);
  const s = await asking(a, false);
  // Another process turned the kill switch on; this process has not looked yet.
  const cfg = a.rt.store.config();
  a.rt.store.saveConfig({ ...cfg, portfolio: { ...cfg.portfolio, killSwitch: true } });
  await a.rt.sponsor.viewed(s.id, { kind: 'escalation', id: s.q.id }, s.q.id);
  await expect(a.rt.sponsor.answer(s.id, s.q.id, 'yes')).rejects.toThrow(/kill switch/);
  const ctx = { programId: s.id, wpId: 'wp1' };
  const req = { kind: 'tool', question: 'q?', risk: 'read', runId: 'run-y' } as const;
  expect(await a.rt.ctx.gate.decide(ctx, req)).toBe(false);
  expect(open(a, s.id)).toHaveLength(1);
  a.rt.ctx.gate.abandon(s.runId, 'test over');
});

it('a yes that landed just before the cancel is still a no for the cancelled run', async () => {
  a = world({}, undefined, SLOW);
  const d = await a.rt.create({ goal: 'one thing', budgetUsd: 10, critic: false });
  await a.rt.sponsor.act(d.programId, { type: 'approve', charterHash: d.charterHash });
  const ctx = { programId: d.programId, wpId: 'wp1' };
  const req = {
    kind: 'tool',
    question: 'q?',
    risk: 'read',
    physical: false,
    runId: 'run-z',
  } as const;
  const asked = a.rt.ctx.gate.decide(ctx, req);
  for (let i = 0; i < 100 && !open(a, d.programId).length; i++) await sleep(5);
  const [q] = open(a, d.programId);
  await a.rt.sponsor.answer(d.programId, q!.id, 'yes');
  // The gate has not polled yet (once a minute here) when the run is cancelled.
  a.rt.ctx.gate.abandon('run-z', 'run cancelled');
  expect(await asked).toBe(false);
  expect(a.rt.ctx.gate.takeVoided('run-z')).toBe('run cancelled');
  expect(a.rt.ctx.gate.takeVoided('run-z')).toBeUndefined();
});
