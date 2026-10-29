/**
 * P5-F1 (D-035): the kill switch, a stop or a pause issued from another process on the same
 * `$KPAI_HOME` (the console, `kpai program stop`) reaches the daemon's live runs: the
 * daemon reads the store on each tick and on its own short guard timer, and cancels or
 * pauses the runs it started. A = the daemon's process, B = the console's.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cancelling, fakeStarter, type Fake } from './test-helpers/fake.js';
import { world, type World } from './test-helpers/world.js';

let a: World | undefined;
let b: World | undefined;
afterEach(async () => {
  await b?.close();
  await a?.close();
  a = b = undefined;
});

/** A daemon (A) with two live runs of one approved program, and a console (B) on its home. */
async function twoProcesses(): Promise<{ fake: Fake; id: string }> {
  a = world();
  const fake = fakeStarter(a.rt);
  const d = await a.rt.create({ goal: 'Two parts:\n- one\n- two', budgetUsd: 10, critic: false });
  await a.rt.sponsor.act(d.programId, { type: 'approve', charterHash: d.charterHash });
  await a.rt.daemon.tick();
  expect(fake.runs).toHaveLength(2);
  b = world({}, a.host);
  return { fake, id: d.programId };
}

const facts = (x: World, id: string, action: string) =>
  x.kernel
    .events(x.rt.ctx.sessionOf(id), 10_000)
    .filter((e) => e.type === 'intervention' && e.payload['action'] === action);

it('a kill switch turned on by another process cancels the daemon’s runs on its next tick', async () => {
  const { fake, id } = await twoProcesses();
  const cancel = cancelling(a!, fake);
  // B cannot reach A's kernel runs: nothing it holds is cancelled.
  expect(await b!.rt.daemon.kill(true)).toEqual([]);
  expect(cancel).not.toHaveBeenCalled();
  await a!.rt.daemon.tick();
  await a!.rt.idle();
  expect(cancel.mock.calls.map(([r]) => r).sort()).toEqual(fake.runs.map((r) => r.runId).sort());
  expect(a!.rt.ctx.live.size).toBe(0);
  expect(a!.rt.get(id).runs.every((r) => r.status === 'cancelled')).toBe(true);
  expect(facts(a!, id, 'run cancelled by the daemon')).toHaveLength(2);
  // Asked once: later checks do not cancel again.
  await a!.rt.daemon.tick();
  expect(cancel).toHaveBeenCalledTimes(2);
});

it('`kpai program stop` from another process cancels the program’s runs within one guard check', async () => {
  const { fake, id } = await twoProcesses();
  const cancel = cancelling(a!, fake);
  // The daemon was started: its guard timer is shorter than its tick (60 s here).
  expect(await a!.rt.daemon.start()).toBe(true);
  await b!.rt.sponsor.stop(id, 'stop from the console');
  expect(b!.rt.get(id).status).toBe('stopped');
  await new Promise((r) => setTimeout(r, 600));
  await a!.rt.idle();
  expect(cancel).toHaveBeenCalledTimes(2);
  expect(a!.rt.ctx.live.size).toBe(0);
  expect(a!.rt.get(id).runs.map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
  const why = facts(a!, id, 'run cancelled by the daemon').map((e) => e.payload['why']);
  expect(why).toEqual(['program stopped', 'program stopped']);
});

it('a Sponsor pause from another process pauses the runs; resume resumes them', async () => {
  const { fake, id } = await twoProcesses();
  const cancel = cancelling(a!, fake);
  await b!.rt.sponsor.act(id, { type: 'pause' });
  await a!.rt.daemon.tick();
  const pause = a!.kernel.pause as unknown as { mock: { calls: unknown[][] } };
  const resume = a!.kernel.resume as unknown as { mock: { calls: unknown[][] } };
  expect(pause.mock.calls.map(([r]) => r).sort()).toEqual(fake.runs.map((r) => r.runId).sort());
  expect(cancel).not.toHaveBeenCalled();
  // Paused once, not again on the next check.
  await a!.rt.daemon.tick();
  expect(pause.mock.calls).toHaveLength(2);
  expect(resume.mock.calls).toHaveLength(0);
  await b!.rt.sponsor.act(id, { type: 'resume' });
  await a!.rt.daemon.tick();
  expect(resume.mock.calls).toHaveLength(2);
  expect(a!.rt.ctx.live.size).toBe(2);
  expect(facts(a!, id, 'run paused by the daemon')).toHaveLength(2);
  expect(facts(a!, id, 'run resumed by the daemon')).toHaveLength(2);
  fake.runs.forEach((r) => r.finish());
});

it('the guard never throws: unreadable settings or programs leave the runs alone', async () => {
  const { fake, id } = await twoProcesses();
  const cancel = cancelling(a!, fake);
  const store = a!.rt.ctx.store;
  const config = vi.spyOn(store, 'config').mockImplementation(() => {
    throw new Error('portfolio.json does not parse');
  });
  const read = vi.spyOn(store, 'read').mockImplementation(() => {
    throw new Error('disk gone');
  });
  expect(a!.rt.daemon.guard()).toEqual({ cancel: [], pause: [], resume: [] });
  expect(cancel).not.toHaveBeenCalled();
  config.mockRestore();
  read.mockRestore();
  // A journal that fails while acting is reported in the feed, never thrown.
  await b!.rt.sponsor.act(id, { type: 'pause' });
  vi.spyOn(a!.rt.ctx, 'fact').mockImplementation(() => {
    throw new Error('journal full');
  });
  expect(a!.rt.daemon.guard()).toBeUndefined();
  expect(a!.rt.activity().items.some((x) => /run guard failed: journal full/.test(x.text))).toBe(
    true,
  );
  vi.restoreAllMocks();
  fake.runs.forEach((r) => r.finish());
});
