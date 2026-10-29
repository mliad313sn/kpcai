/**
 * ADR-0035: a daemon's run is unattended (D-029 R1, journaled with the run) and carries its
 * intent (S10 R6 J1); facts and session spend are readable for the Enterprise runtime.
 */
import { describe, expect, it } from 'vitest';
import { openJournal } from './env.js';
import { Kernel } from './kernel.js';
import { REQ, TEST_OPTIONS, recordingHost } from './test-helpers/fixture.js';

const IN_PLACE = { ...TEST_OPTIONS, isolated: false } as const;

/** The `run started` record (a replay record, hidden from `events`), read from the journal. */
function startedRouting(env: Record<string, string | undefined>, sessionId: string): unknown {
  const j = openJournal(env);
  try {
    const e = j
      .events({ sessionId, limit: 100_000 })
      .find((x) => x.payload['action'] === 'run started');
    return e?.payload['routing'];
  } finally {
    j.close();
  }
}

describe('unattended runs and intents', () => {
  it('journals the intent and passes unattended to the runner', async () => {
    const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100' });
    const k = new Kernel(host);
    const sessionId = k.openSession('program prog-1 wp1', false);
    const plan = await k.plan(REQ, IN_PLACE, sessionId);
    const intent = { id: 'prog-1/wp1', origin: 'charter-wp:abc' };
    const h = await k.startRun({
      request: REQ,
      planId: plan.planId,
      options: { ...IN_PLACE, unattended: true, intent },
    });
    await h.done;
    const events = k.events(sessionId, 10_000);
    const rec = events.find((e) => e.payload['action'] === 'run intent');
    expect(rec?.payload).toMatchObject({ runId: h.runId, intent, unattended: true });
    expect(startedRouting(host.env, sessionId)).toMatchObject({ unattended: true });
    expect(k.sessionSpendUsd(sessionId)).toBeGreaterThan(0);
    const seq = k.recordFact(sessionId, { action: 'enterprise heartbeat' });
    expect(seq).toBeGreaterThan(rec!.seq);
    await k.close();
  });

  it('an interactive run serves its own human request (J1, B-28) and is not unattended', async () => {
    const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100' });
    const k = new Kernel(host);
    const sessionId = k.openSession('interactive', false);
    const plan = await k.plan(REQ, IN_PLACE, sessionId);
    const h = await k.startRun({ request: REQ, planId: plan.planId, options: IN_PLACE });
    await h.done;
    const events = k.events(sessionId, 10_000);
    const intents = events.filter((e) => e.payload['action'] === 'run intent');
    expect(intents.map((e) => e.payload)).toEqual([
      {
        action: 'run intent',
        runId: h.runId,
        intent: { id: h.runId, origin: 'human-request' },
        unattended: false,
      },
    ]);
    expect(startedRouting(host.env, sessionId)).not.toHaveProperty('unattended');
    await k.close();
  });
});
