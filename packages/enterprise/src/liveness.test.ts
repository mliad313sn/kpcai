/**
 * S10 R2: the heartbeat is journaled and written to the dead-man file; a reader sees it go
 * stale when the daemon stops beating; the watchdog alerts a stalled worker once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HeartbeatSchema } from '@kernelpai/kernel/protocol';
import { readHeartbeat, HEARTBEAT_FILE } from './liveness.js';
import { fakeStarter } from './test-helpers/fake.js';
import { world, type World } from './test-helpers/world.js';

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe('heartbeat, dead-man file and watchdog', () => {
  it('journals a heartbeat at start and writes a file that goes stale', async () => {
    w = world();
    w.config({ heartbeatSec: 10 });
    expect(await w.rt.daemon.start()).toBe(true);
    const hb = HeartbeatSchema.parse(w.rt.heartbeat());
    expect(hb).toMatchObject({ status: 'ok', intervalSec: 10, staleAfterSec: 30 });
    const path = w.rt.store.path(HEARTBEAT_FILE);
    expect(readHeartbeat(path, new Date(Date.now() + 29_000))?.status).toBe('ok');
    expect(readHeartbeat(path, new Date(Date.now() + 31_000))?.status).toBe('stale');
    const beats = w.kernel.sessions(50).flatMap((s) => w!.kernel.events(s.id, 1_000));
    expect(beats.some((e) => e.payload['action'] === 'enterprise heartbeat')).toBe(true);
    expect(w.emitted.some((e) => e.name === 'enterprise.heartbeat')).toBe(true);
  });

  it('a missing heartbeat reads as stale', () => {
    w = world();
    expect(w.rt.heartbeat().status).toBe('stale');
    expect(readHeartbeat(w.rt.store.path('nope.json'), new Date())).toBeUndefined();
  });

  it('alerts a run silent past the stall window, once, then clears', async () => {
    w = world();
    let now = new Date();
    w.rt.ctx.clock = () => now;
    w.config({ heartbeatSec: 1, watch: { runStallMinutes: 5 } });
    const fake = fakeStarter(w.rt);
    const d = await w.rt.create({ goal: 'one thing', budgetUsd: 10, critic: false });
    await w.rt.sponsor.act(d.programId, { type: 'approve', charterHash: d.charterHash });
    await w.rt.daemon.tick();
    await w.rt.idle();
    now = new Date(now.getTime() + 6 * 60_000);
    await w.rt.daemon.tick();
    expect(w.rt.heartbeat()).toMatchObject({
      status: 'alert',
      alerts: [expect.objectContaining({ rule: 'run.stalled' })],
    });
    now = new Date(now.getTime() + 2_000);
    await w.rt.daemon.tick();
    const lines = w.rt.activity().items.filter((a) => /watchdog: run.stalled/.test(a.text));
    expect(lines).toHaveLength(1);
    // Activity on the run silences it.
    w.rt.touch(fake.runs[0]!.runId);
    now = new Date(now.getTime() + 2_000);
    await w.rt.daemon.tick();
    expect(w.rt.heartbeat().status).toBe('ok');
    fake.runs.forEach((r) => r.finish());
  });
});
