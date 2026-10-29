/**
 * S10 R6 J5 (B-28): the journaled heartbeat carries its interval, the queue depth and the
 * age of the oldest open question, so G3 can find heartbeat gaps from the journal alone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { oldestAskAge } from './liveness.js';
import { world, type World } from './test-helpers/world.js';

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe('heartbeat journal fields (J5)', () => {
  it('journals interval, queue depth and oldest open question', async () => {
    w = world();
    w.config({ heartbeatSec: 7 });
    expect(await w.rt.daemon.start()).toBe(true);
    const beat = w.kernel
      .sessions(50)
      .flatMap((s) => w!.kernel.events(s.id, 1_000))
      .find((e) => e.payload['action'] === 'enterprise heartbeat');
    expect(beat?.payload).toMatchObject({ intervalSec: 7, queued: 0, oldestAskAgeSec: null });
  });

  it('the oldest unanswered question sets the age; answered ones do not', () => {
    const now = new Date('2026-10-23T12:00:00Z');
    const programs = [
      {
        escalations: [
          { at: '2026-10-23T11:00:00Z', answer: 'yes' },
          { at: '2026-10-23T11:30:00Z' },
        ],
      },
      { escalations: [{ at: '2026-10-23T11:50:00Z' }, { at: 'not a date' }] },
    ];
    expect(oldestAskAge(programs, now)).toBe(1800);
    expect(oldestAskAge([{ escalations: [] }], now)).toBeNull();
  });
});
