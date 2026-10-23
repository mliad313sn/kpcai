/**
 * Enterprise intents → protocol calls (design §14.1, packages/kernel protocol-enterprise.ts).
 * Every answer the Sponsor gives goes through `program.answer`; the console never decides
 * on the Sponsor's behalf. S10 R8: opening an ask's evidence is journaled
 * (`program.viewed`), a yes to a consequential ask is refused here (and by the kernel)
 * until then, and only `trivial` asks can be answered as a batch.
 */
import { ErrorCodes } from '@kernelpai/kernel/protocol';
import { t, type Key } from '../i18n/core';
import { RpcError } from '../rpc/client';
import { isMethodNotFound } from '../rpc/raw';
import { call } from '../store/actions';
import { announce, log } from '../store/store';
import type { InboxItem } from './schemas';
import { applyNotices, fromSnapshot, markViewed, withActivity, withoutEscalation } from './state';
import {
  enterprise,
  patchUi,
  setData,
  setHolding,
  setResyncHandler,
  takeHeld,
  type ProgramAction,
} from './store';

/** Feed lines fetched after a snapshot (the stream only carries new ones). */
export const BACKFILL = 1000;

function report(key: Key, e: unknown): void {
  const msg = t(key, { error: e instanceof Error ? e.message : String(e) });
  log('error', msg);
  announce(msg);
}

/** No Enterprise runtime behind this kernel (or a kernel without the methods). */
const unavailable = (e: unknown): boolean =>
  isMethodNotFound(e) || (e instanceof RpcError && e.code === ErrorCodes.unsupported);

let inFlight: Promise<void> | undefined;

/** Loads (or reloads) the whole view; notices that arrive meanwhile are replayed on top. */
export function loadSnapshot(): Promise<void> {
  inFlight ??= doLoad().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function doLoad(): Promise<void> {
  // A reload keeps the current view on screen; only the first load shows "loading".
  if (enterprise.getState().ui.status !== 'ready') patchUi({ status: 'loading' });
  setHolding(true);
  try {
    const snap = await call('enterprise.snapshot', {});
    const held = takeHeld().filter((n) => n.params.seq > snap.cursor);
    setData((d) => applyNotices(fromSnapshot(snap, d), held));
    patchUi({ status: 'ready', error: undefined });
    void backfill(snap.cursor);
  } catch (e) {
    takeHeld();
    if (unavailable(e)) return patchUi({ status: 'unavailable' });
    patchUi({ status: 'error', error: e instanceof Error ? e.message : String(e) });
  } finally {
    setHolding(false);
  }
}

/** The recent feed lines up to the snapshot's cursor; a failure leaves the feed live-only. */
async function backfill(cursor: number): Promise<void> {
  try {
    const r = await call('enterprise.activity', {
      since: Math.max(0, cursor - BACKFILL),
      limit: BACKFILL,
    });
    setData((d) => withActivity(d, r.items));
  } catch (e) {
    log('warn', t('ent.fail.activity', { error: e instanceof Error ? e.message : String(e) }));
  }
}

let resyncTimer: ReturnType<typeof setTimeout> | undefined;

/** A gap in the stream: one new snapshot shortly, however many gaps arrive meanwhile. */
export function scheduleResync(delayMs = 250): void {
  if (resyncTimer) return;
  resyncTimer = setTimeout(() => {
    resyncTimer = undefined;
    void loadSnapshot();
  }, delayMs);
}

setResyncHandler(() => scheduleResync());

const CONTROL_TEXT: Record<ProgramAction, Key> = {
  pause: 'ent.announce.paused',
  resume: 'ent.announce.resumed',
  stop: 'ent.announce.stopped',
};

async function control(programId: string, action: ProgramAction): Promise<void> {
  if (action === 'pause') await call('program.pause', { programId });
  else if (action === 'resume') await call('program.resume', { programId });
  else await call('program.stop', { programId });
}

/** Pause, resume or stop one program (Sponsor). Stop is confirmed by the view first. */
export async function programControl(programId: string, action: ProgramAction): Promise<void> {
  const ui = enterprise.getState().ui;
  if (ui.busy[programId]) return;
  patchUi({ busy: { ...ui.busy, [programId]: action }, stopAsk: undefined });
  try {
    await control(programId, action);
    announce(t(CONTROL_TEXT[action], { program: programId }));
  } catch (e) {
    report('ent.fail.control', e);
  } finally {
    clearBusy(programId);
  }
}

export const isConsequential = (item: InboxItem): boolean => item.class !== 'trivial';

/** R8: a consequential yes needs the evidence opened first; a no never does. */
export function canApprove(item: InboxItem): boolean {
  return !isConsequential(item) || item.viewed === true;
}

/** Opens (or closes) an ask's evidence; opening is journaled by the kernel (J2, R8). */
export async function toggleEvidence(item: InboxItem): Promise<void> {
  const id = item.escalationId;
  if (enterprise.getState().ui.evidenceOpen === id) return patchUi({ evidenceOpen: undefined });
  patchUi({ evidenceOpen: id });
  if (item.viewed) return;
  try {
    await call('program.viewed', {
      programId: item.programId,
      escalationId: id,
      ref: { kind: 'escalation', id },
    });
    setData((d) => markViewed(d, id));
  } catch (e) {
    report('ent.fail.viewed', e);
  }
}

/** Answers one ask. Returns false when nothing was sent (evidence not opened yet). */
export async function answer(item: InboxItem, yes: boolean): Promise<boolean> {
  if (yes && !canApprove(item)) {
    announce(t('ent.inbox.openFirst'));
    return false;
  }
  try {
    await call('program.answer', {
      programId: item.programId,
      escalationId: item.escalationId,
      answer: yes ? 'yes' : 'no',
    });
    setData((d) => withoutEscalation(d, item.escalationId));
    announce(t(yes ? 'ent.announce.approved' : 'ent.announce.declined'));
    return true;
  } catch (e) {
    report('ent.fail.answer', e);
    return false;
  }
}

function byProgram(items: readonly InboxItem[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const i of items)
    groups.set(i.programId, [...(groups.get(i.programId) ?? []), i.escalationId]);
  return groups;
}

/** Answers every trivial ask in one decision (R8); consequential ones are never batched. */
export async function answerBatch(items: readonly InboxItem[], yes: boolean): Promise<number> {
  let done = 0;
  for (const [programId, ids] of byProgram(items.filter((i) => !isConsequential(i)))) {
    try {
      const r = await call('program.answerBatch', {
        programId,
        escalationIds: ids,
        answer: yes ? 'yes' : 'no',
      });
      for (const id of r.answered) setData((d) => withoutEscalation(d, id));
      done += r.answered.length;
      if (r.refused.length) log('warn', t('ent.inbox.refused', { count: r.refused.length }));
    } catch (e) {
      report('ent.fail.answer', e);
    }
  }
  patchUi({ batchOpen: false });
  announce(t('ent.announce.batch', { count: done }));
  return done;
}

/** Stop everything (Simplicity Charter: one action); the portfolio stays resumable. */
export async function kill(): Promise<void> {
  if (enterprise.getState().ui.busy.portfolio) return;
  patchUi({ busy: { ...enterprise.getState().ui.busy, portfolio: 'kill' } });
  try {
    const r = await call('enterprise.kill', {});
    setData((d) => ({ ...d, killSwitch: true }));
    announce(t('ent.announce.killed', { count: r.cancelled.length }));
  } catch (e) {
    report('ent.fail.kill', e);
  } finally {
    clearBusy('portfolio');
  }
}

export async function unkill(): Promise<void> {
  if (enterprise.getState().ui.busy.portfolio) return;
  patchUi({ busy: { ...enterprise.getState().ui.busy, portfolio: 'unkill' } });
  try {
    await call('enterprise.unkill', {});
    setData((d) => ({ ...d, killSwitch: false }));
    announce(t('ent.announce.unkilled'));
  } catch (e) {
    report('ent.fail.kill', e);
  } finally {
    clearBusy('portfolio');
  }
}

function clearBusy(key: string): void {
  const busy = { ...enterprise.getState().ui.busy };
  delete busy[key];
  patchUi({ busy });
}
