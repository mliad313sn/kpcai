/** S10 R6 J2: answered questions of a run, journaled with their times (B-28, B-37). */
import { Journal } from '@kernelpai/journal';
import { describe, expect, it } from 'vitest';
import { askJournal, askRecord, consequentialAsk } from './asks.js';
import { hostConfirm, type ConfirmRequest } from './confirm.js';
import { intentRecord, runIntent } from './run-record.js';

const q = (o: Partial<ConfirmRequest>): ConfirmRequest => ({ kind: 'tool', question: 'ok?', ...o });

describe('consequential questions (G2)', () => {
  it('writes to the user tree, restores, spend, destructive or physical steps', () => {
    expect(consequentialAsk(q({ kind: 'patch' }))).toBe(true);
    expect(consequentialAsk(q({ kind: 'patch', inWorktree: true }))).toBe(false);
    expect(consequentialAsk(q({ kind: 'artifact', inWorktree: false }))).toBe(true);
    expect(consequentialAsk(q({ kind: 'budget' }))).toBe(true);
    expect(consequentialAsk(q({ kind: 'restore' }))).toBe(true);
    expect(consequentialAsk(q({ kind: 'dispute' }))).toBe(true);
    expect(consequentialAsk(q({ kind: 'tool', risk: 'destructive' }))).toBe(true);
    expect(consequentialAsk(q({ kind: 'tool', risk: 'write', physical: true }))).toBe(true);
    expect(consequentialAsk(q({ kind: 'tool', risk: 'write' }))).toBe(false);
    expect(consequentialAsk(q({ kind: 'memory' }))).toBe(false);
  });

  it('records times, answer and whether the diff was shown, never the text', () => {
    const a = {
      askedAt: new Date('2026-10-23T10:00:00Z'),
      answeredAt: new Date('2026-10-23T10:00:04Z'),
    };
    const r = askRecord(
      q({ kind: 'patch', patch: 'diff --git secret', runId: 'r1', risk: 'write' }),
      { ...a, yes: true },
    );
    expect(r).toEqual({
      action: 'confirmation answered',
      runId: 'r1',
      kind: 'patch',
      risk: 'write',
      consequential: true,
      answer: 'yes',
      askedAt: '2026-10-23T10:00:00.000Z',
      answeredAt: '2026-10-23T10:00:04.000Z',
      viewed: 'diff',
    });
    expect(askRecord(q({ kind: 'budget' }), { ...a, yes: false })).toMatchObject({
      answer: 'no',
      viewed: 'none',
    });
  });
});

describe('askJournal through hostConfirm', () => {
  it('journals answers of a known run in its session; others and errors are not recorded', async () => {
    const j = Journal.open(':memory:');
    const sessionId = j.startSession('t', '/repo');
    const runs = new Map([['r1', { plan: { sessionId } }]]);
    const answers = [true, false];
    const confirm = hostConfirm(
      async () => answers.shift() ?? false,
      (r) => r.runId === 'void',
      undefined,
      askJournal(() => j, runs),
    );
    expect(await confirm(q({ runId: 'r1', kind: 'patch' }))).toBe(true);
    expect(await confirm(q({ kind: 'budget' }))).toBe(false); // no run: not recorded
    expect(await confirm(q({ runId: 'void' }))).toBe(false); // voided: never asked
    const recorded = j.events({ sessionId }).map((e) => e.payload);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      action: 'confirmation answered',
      runId: 'r1',
      answer: 'yes',
    });
    const throwing = hostConfirm(
      () => Promise.reject(new Error('host gone')),
      undefined,
      undefined,
      askJournal(() => j, runs),
    );
    await expect(throwing(q({ runId: 'r1' }))).rejects.toThrow('host gone');
    const broken = hostConfirm(
      async () => true,
      undefined,
      undefined,
      () => {
        throw new Error('journal closed');
      },
    );
    expect(await broken(q({ runId: 'r1' }))).toBe(true);
    expect(j.events({ sessionId })).toHaveLength(1);
  });
});

describe('run intent (J1)', () => {
  it('a typed request is its own human intent; programs name theirs; forks inherit', () => {
    expect(runIntent('r1', {}, false)).toEqual({ id: 'r1', origin: 'human-request' });
    const wp = { id: 'p/wp1', origin: 'charter-wp:ab' };
    expect(runIntent('r1', { intent: wp, unattended: true }, false)).toEqual(wp);
    expect(runIntent('r1', {}, true)).toBeUndefined();
    expect(runIntent('r1', { unattended: true }, false)).toBeUndefined();
    expect(intentRecord('s', 'r1', {}, { id: 'r1', origin: 'human-request' })).toEqual({
      sessionId: 's',
      type: 'intervention',
      payload: {
        action: 'run intent',
        runId: 'r1',
        intent: { id: 'r1', origin: 'human-request' },
        unattended: false,
      },
    });
  });
});
