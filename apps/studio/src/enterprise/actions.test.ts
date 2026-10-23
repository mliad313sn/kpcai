import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, disconnect } from '../connection';
import { initialState, studio } from '../store/store';
import { FakeKernel, RpcFailure, TOKEN, until } from '../test-helpers/fake-kernel';
import { enterpriseFake, seat, snapshot } from '../test-helpers/enterprise-fixtures';
import { kernelHandlers } from '../test-helpers/fixtures';
import { WS } from '../test-helpers/ui';
import {
  answer,
  answerBatch,
  canApprove,
  kill,
  loadSnapshot,
  programControl,
  scheduleResync,
  toggleEvidence,
  unkill,
} from './actions';
import { enterprise, flushNotices, receiveNotice, resetEnterprise } from './store';

let kernel: FakeKernel;

async function start(handlers: Record<string, (p: unknown) => unknown> = {}): Promise<void> {
  studio.setState(initialState(), true);
  resetEnterprise();
  kernel = await new FakeKernel({
    ...kernelHandlers(),
    ...enterpriseFake().handlers,
    ...handlers,
  }).start();
  connect(kernel.url, TOKEN, { WebSocketImpl: WS, backoff: { initialMs: 10, maxMs: 20 } });
  await until(() => studio.getState().conn === 'open');
}

const ent = () => enterprise.getState();

beforeEach(() => resetEnterprise());
afterEach(async () => {
  disconnect();
  await kernel?.stop();
});

describe('enterprise actions (design §14.1)', () => {
  it('loads the snapshot and backfills the feed', async () => {
    await start();
    await loadSnapshot();
    expect(ent().ui.status).toBe('ready');
    expect(ent().data.seats).toHaveLength(6);
    await until(() => ent().data.activity.length === 2);
    expect(kernel.calls('enterprise.activity')[0]).toEqual({ since: 0, limit: 1000 });
  });

  it('says when the kernel runs no Enterprise mode, and reports other failures', async () => {
    await start({
      'enterprise.snapshot': () => {
        throw new RpcFailure(-32005, 'Enterprise mode is not enabled on this server');
      },
    });
    await loadSnapshot();
    expect(ent().ui.status).toBe('unavailable');
    kernel.handlers.set('enterprise.snapshot', () => {
      throw new Error('disk full');
    });
    resetEnterprise();
    await loadSnapshot();
    expect(ent().ui).toMatchObject({ status: 'error', error: 'disk full' });
  });

  it('keeps a live feed when the backfill fails', async () => {
    await start({
      'enterprise.activity': () => {
        throw new Error('no feed');
      },
    });
    await loadSnapshot();
    await until(() => studio.getState().logs.some((l) => l.message.includes('no feed')));
    expect(ent().ui.status).toBe('ready');
  });

  it('coalesces stream notices per frame and replays those held during a load', async () => {
    await start();
    expect(receiveNotice('enterprise.seat', { ...seat(1), seq: 1 })).toBe(true);
    expect(ent().data.seats).toHaveLength(0); // dropped: the view never loaded
    const loading = loadSnapshot();
    receiveNotice('enterprise.seat', { ...seat(2), state: 'writing', seq: 41 });
    receiveNotice('enterprise.seat', { ...seat(2), state: 'thinking', seq: 30 });
    await loading;
    expect(ent().data.seats.find((s) => s.seatId === 's2')?.state).toBe('writing');
    expect(receiveNotice('enterprise.seat', { bad: true })).toBe(false);
    receiveNotice('enterprise.seat', { ...seat(3), state: 'blocked', seq: 42 });
    expect(ent().data.seats.find((s) => s.seatId === 's3')?.state).not.toBe('blocked');
    flushNotices();
    expect(ent().data.seats.find((s) => s.seatId === 's3')?.state).toBe('blocked');
    flushNotices(); // nothing queued: no change
  });

  it('reloads once after a gap in the stream, and on the stream through the client', async () => {
    await start();
    await loadSnapshot();
    const before = kernel.calls('enterprise.snapshot').length;
    kernel.notify('enterprise.seat', { ...seat(1), state: 'idle', seq: 45 });
    await until(() => kernel.calls('enterprise.snapshot').length === before + 1, 3000);
    scheduleResync(5);
    scheduleResync(5);
    await until(() => kernel.calls('enterprise.snapshot').length === before + 2, 3000);
  });

  it('pauses, resumes and stops programs, one call at a time', async () => {
    await start();
    await loadSnapshot();
    const p = programControl('p-auth', 'pause');
    expect(ent().ui.busy['p-auth']).toBe('pause');
    await programControl('p-auth', 'pause'); // busy: ignored
    await p;
    await programControl('p-auth', 'resume');
    await programControl('p-auth', 'stop');
    expect(kernel.calls('program.pause')).toEqual([{ programId: 'p-auth' }]);
    expect(kernel.calls('program.resume')).toHaveLength(1);
    expect(kernel.calls('program.stop')).toHaveLength(1);
    expect(ent().ui.busy).toEqual({});
    kernel.handlers.set('program.pause', () => {
      throw new Error('nope');
    });
    await programControl('p-auth', 'pause');
    expect(studio.getState().logs.at(-1)?.message).toContain('nope');
  });

  it('refuses a consequential yes until the evidence was opened (S10 R8)', async () => {
    await start();
    await loadSnapshot();
    const merge = ent().data.inbox[0]!;
    expect(canApprove(merge)).toBe(false);
    expect(await answer(merge, true)).toBe(false);
    expect(kernel.calls('program.answer')).toHaveLength(0);
    await toggleEvidence(merge);
    expect(kernel.calls('program.viewed')).toEqual([
      { programId: 'p-auth', escalationId: 'e-merge', ref: { kind: 'escalation', id: 'e-merge' } },
    ]);
    const viewed = ent().data.inbox[0]!;
    expect(viewed.viewed).toBe(true);
    expect(ent().ui.evidenceOpen).toBe('e-merge');
    await toggleEvidence(viewed);
    expect(ent().ui.evidenceOpen).toBeUndefined();
    await toggleEvidence(viewed); // already viewed: no second call
    expect(kernel.calls('program.viewed')).toHaveLength(1);
    expect(await answer(viewed, true)).toBe(true);
    expect(ent().data.inbox.map((i) => i.escalationId)).toEqual(['e-t1', 'e-t2']);
  });

  it('can always decline, and reports a refused answer', async () => {
    await start();
    await loadSnapshot();
    const merge = ent().data.inbox[0]!;
    expect(await answer(merge, false)).toBe(true);
    expect(kernel.calls('program.answer')[0]).toMatchObject({ answer: 'no' });
    kernel.handlers.set('program.answer', () => {
      throw new Error('gone');
    });
    expect(await answer(ent().data.inbox[0]!, false)).toBe(false);
    kernel.handlers.set('program.viewed', () => {
      throw new Error('cannot record');
    });
    await toggleEvidence({ ...merge, escalationId: 'e-x' });
    expect(studio.getState().logs.at(-1)?.message).toContain('cannot record');
  });

  it('answers only trivial asks as a batch, one call per program', async () => {
    await start({
      'program.answerBatch': (p) => ({
        answered: (p as { escalationIds: string[] }).escalationIds,
        refused: [{ escalationId: 'zz', reason: 'consequential' }],
      }),
    });
    await loadSnapshot();
    const done = await answerBatch(ent().data.inbox, true);
    expect(done).toBe(2);
    expect(kernel.calls('program.answerBatch')).toEqual([
      { programId: 'p-auth', escalationIds: ['e-t1'], answer: 'yes' },
      { programId: 'p-bracket', escalationIds: ['e-t2'], answer: 'yes' },
    ]);
    expect(ent().data.inbox.map((i) => i.escalationId)).toEqual(['e-merge']);
    kernel.handlers.set('program.answerBatch', () => {
      throw new Error('batch down');
    });
    expect(await answerBatch(snapshot().inbox, false)).toBe(0);
  });

  it('stops everything in one action and can allow work again', async () => {
    await start();
    await loadSnapshot();
    await kill();
    expect(ent().data.killSwitch).toBe(true);
    expect(studio.getState().announcement.text).toContain('2 runs cancelled');
    await unkill();
    expect(ent().data.killSwitch).toBe(false);
    kernel.handlers.set('enterprise.kill', () => {
      throw new Error('kill failed');
    });
    kernel.handlers.set('enterprise.unkill', () => {
      throw new Error('unkill failed');
    });
    await kill();
    await unkill();
    expect(studio.getState().logs.filter((l) => l.level === 'error')).toHaveLength(2);
    enterprise.setState((s) => ({ ui: { ...s.ui, busy: { portfolio: 'kill' } } }));
    await kill();
    await unkill();
    expect(kernel.calls('enterprise.kill')).toHaveLength(2);
  });

  it('reloads a shown view when the connection comes back', async () => {
    await start();
    await loadSnapshot();
    const before = kernel.calls('enterprise.snapshot').length;
    kernel.dropClients();
    await until(() => kernel.calls('enterprise.snapshot').length > before, 3000);
  });
});
