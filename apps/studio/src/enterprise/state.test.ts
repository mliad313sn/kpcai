import { describe, expect, it } from 'vitest';
import { ACTIVITY, AT, seat, snapshot } from '../test-helpers/enterprise-fixtures';
import { parseNotice, type AnyNotice } from './schemas';
import {
  MAX_ACTIVITY,
  applyNotice,
  applyNotices,
  emptyState,
  fromSnapshot,
  markViewed,
  withActivity,
  withoutEscalation,
  type EntState,
} from './state';

function notice(name: string, params: Record<string, unknown>): AnyNotice {
  const n = parseNotice(name, params);
  if (!n) throw new Error(`invalid ${name}`);
  return n;
}

const loaded = (): EntState => fromSnapshot(snapshot());

describe('enterprise state (R-5E10)', () => {
  it('starts empty and takes a snapshot whole', () => {
    expect(emptyState()).toMatchObject({ loaded: false, cursor: 0, seats: [] });
    const s = loaded();
    expect(s).toMatchObject({ loaded: true, cursor: 40, killSwitch: false, resync: false });
    expect(s.seats).toHaveLength(6);
    expect(s.reports.map((r) => r.reportId)).toEqual(['r2', 'r1']);
    expect(s.results).toHaveLength(3);
    expect(s.queue).toHaveLength(1);
    expect(s.heartbeat?.intervalSec).toBe(60);
  });

  it('rejects unknown or malformed notifications', () => {
    expect(parseNotice('enterprise.nope', {})).toBeUndefined();
    expect(parseNotice('enterprise.seat', { seq: 1 })).toBeUndefined();
  });

  it('upserts seats and gauges, ignores duplicates and flags gaps', () => {
    let s = loaded();
    s = applyNotice(s, notice('enterprise.seat', { ...seat(2), state: 'writing', seq: 41 }));
    expect(s.seats.find((x) => x.seatId === 's2')?.state).toBe('writing');
    expect(s.cursor).toBe(41);
    const again = applyNotice(s, notice('enterprise.seat', { ...seat(2), state: 'idle', seq: 41 }));
    expect(again).toBe(s);
    s = applyNotice(s, notice('enterprise.seat', { ...seat(99), seq: 42 }));
    expect(s.seats).toHaveLength(7);
    s = applyNotice(
      s,
      notice('enterprise.gauge', { scope: 'source', id: 'ollama', localHours: 4, seq: 43 }),
    );
    expect(s.gauges.find((g) => g.id === 'ollama')?.localHours).toBe(4);
    expect(s.resync).toBe(false);
    s = applyNotice(s, notice('enterprise.heartbeat', { ...snapshot().heartbeat, seq: 50 }));
    expect(s.resync).toBe(true);
    expect(s.cursor).toBe(50);
  });

  it('applies notices before the first snapshot without gap checks', () => {
    const s = applyNotice(emptyState(), notice('enterprise.seat', { ...seat(1), seq: 9 }));
    expect(s.seats).toHaveLength(1);
    expect(s.resync).toBe(false);
  });

  it('moves work packages between seats and counts them per program', () => {
    let s = loaded();
    s = applyNotice(
      s,
      notice('enterprise.wp', {
        seq: 41,
        programId: 'p-auth',
        wpId: 'wp0',
        from: 's0',
        to: 's1',
        state: 'review',
      }),
    );
    expect(s.seats.find((x) => x.seatId === 's0')?.wpId).toBeUndefined();
    expect(s.seats.find((x) => x.seatId === 's1')?.wpId).toBe('wp0');
    expect(s.programs[0]!.wps).toEqual([{ wpId: 'wp0', state: 'review' }]);
    s = applyNotice(
      s,
      notice('enterprise.wp', {
        seq: 42,
        programId: 'p-auth',
        wpId: 'wp0',
        to: 's1',
        state: 'done',
      }),
    );
    expect(s.programs[0]!.wps).toEqual([{ wpId: 'wp0', state: 'done' }]);
    // A program update keeps the work packages the client saw; a snapshot too.
    const card = { ...snapshot().programs[0]!, status: 'gate', seq: 43 };
    s = applyNotice(s, notice('enterprise.program', card));
    expect(s.programs[0]).toMatchObject({ status: 'gate', wps: [{ wpId: 'wp0' }] });
    expect(fromSnapshot(snapshot(), s).programs[0]!.wps).toHaveLength(1);
    s = applyNotice(s, notice('enterprise.program', { ...card, programId: 'p-new', seq: 44 }));
    expect(s.programs).toHaveLength(3);
  });

  it('closes answered asks and resyncs for an ask it has no text for', () => {
    let s = loaded();
    s = applyNotice(
      s,
      notice('enterprise.inbox', {
        seq: 41,
        programId: 'p-auth',
        escalationId: 'e-merge',
        state: 'open',
      }),
    );
    expect(s.resync).toBe(false);
    s = applyNotice(
      s,
      notice('enterprise.inbox', {
        seq: 42,
        programId: 'p-auth',
        escalationId: 'e-t1',
        state: 'answered',
      }),
    );
    expect(s.inbox.map((i) => i.escalationId)).toEqual(['e-merge', 'e-t2']);
    s = applyNotice(
      s,
      notice('enterprise.inbox', {
        seq: 43,
        programId: 'p-auth',
        escalationId: 'e-new',
        state: 'open',
      }),
    );
    expect(s.resync).toBe(true);
    expect(withoutEscalation(s, 'e-merge').inbox).toHaveLength(1);
    expect(markViewed(s, 'e-merge').inbox[0]!.viewed).toBe(true);
  });

  it('keeps reports unique and newest first, and caps the feed', () => {
    let s = loaded();
    const rep = {
      seq: 41,
      programId: 'p-auth',
      reportId: 'r3',
      kind: 'final',
      title: 'Done',
      at: AT,
      channels: [],
    };
    s = applyNotice(s, notice('enterprise.report', rep));
    s = applyNotice(s, notice('enterprise.report', { ...rep, seq: 42 }));
    expect(s.reports.map((r) => r.reportId)).toEqual(['r3', 'r2', 'r1']);
    const lines = Array.from({ length: MAX_ACTIVITY + 5 }, (_, i) =>
      notice('enterprise.activity', { seq: 43 + i, at: AT, text: `line ${i}`, refs: [] }),
    );
    s = applyNotices(s, lines);
    expect(s.activity).toHaveLength(MAX_ACTIVITY);
    expect(s.activity[0]!.text).toBe(`line ${MAX_ACTIVITY + 4}`);
  });

  it('merges a feed backfill by sequence, newest first, without duplicates', () => {
    let s = applyNotice(
      loaded(),
      notice('enterprise.activity', { seq: 41, at: AT, text: 'live', refs: [] }),
    );
    s = withActivity(s, [...ACTIVITY, { seq: 41, at: AT, text: 'dup', refs: [] }]);
    expect(s.activity.map((a) => a.seq)).toEqual([41, 39, 38]);
    // A new snapshot keeps lines it covers; later lines come back from the replay.
    expect(fromSnapshot(snapshot(), s).activity.map((a) => a.seq)).toEqual([39, 38]);
  });
});
