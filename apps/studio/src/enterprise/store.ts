/**
 * The Enterprise view's store, apart from the run console's so a burst of seat updates
 * re-renders only the Enterprise components. Notifications are coalesced per animation
 * frame (design §14.3): a frame applies every notice that arrived since the last one.
 */
import { createStore, useStore } from 'zustand';
import { parseNotice, type AnyNotice } from './schemas';
import { applyNotices, emptyState, type EntState } from './state';
import type { SeatFilter } from './derive';

export type EntStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
export type OrgMode = 'team' | 'departments';
export type EntPane = 'org' | 'activity' | 'reports';
export type ProgramAction = 'pause' | 'resume' | 'stop';

export interface EntUi {
  status: EntStatus;
  error?: string;
  /** Team (default, R7) or departments (expert). Kept per viewer. */
  orgMode: OrgMode;
  filter: SeatFilter;
  /** '' shows every program. */
  programFilter: string;
  pane: EntPane;
  /** The escalation whose evidence panel is open. */
  evidenceOpen?: string;
  /** A protocol call in flight, by program id (or `portfolio` for the kill switch). */
  busy: Record<string, ProgramAction | 'kill' | 'unkill' | 'answer'>;
  /** The program whose Stop waits for a confirmation. */
  stopAsk?: string;
  selectedSeat?: string;
  /** The batch of low-risk asks is shown for review. */
  batchOpen: boolean;
}

export interface EntStore {
  data: EntState;
  ui: EntUi;
}

const PREFS_KEY = 'kp-studio.enterprise';

function loadOrgMode(): OrgMode {
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    return raw && (JSON.parse(raw) as { orgMode?: unknown }).orgMode === 'departments'
      ? 'departments'
      : 'team';
  } catch {
    return 'team';
  }
}

export function saveOrgMode(orgMode: OrgMode): void {
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify({ orgMode }));
  } catch {
    /* storage unavailable: the choice lasts for this page */
  }
}

export function initialEnt(): EntStore {
  return {
    data: emptyState(),
    ui: {
      status: 'idle',
      orgMode: loadOrgMode(),
      filter: 'all',
      programFilter: '',
      pane: 'org',
      busy: {},
      batchOpen: false,
    },
  };
}

export const enterprise = createStore<EntStore>(() => initialEnt());

export function useEnt<T>(selector: (s: EntStore) => T): T {
  return useStore(enterprise, selector);
}

export function patchUi(p: Partial<EntUi>): void {
  enterprise.setState((s) => ({ ui: { ...s.ui, ...p } }));
}

export function setData(f: (d: EntState) => EntState): void {
  enterprise.setState((s) => ({ data: f(s.data) }));
}

let queue: AnyNotice[] = [];
/** Notices that arrived while a snapshot was in flight: replayed on top of it. */
let held: AnyNotice[] = [];
let scheduled = false;
/** A snapshot is in flight: notices wait for it. */
let holding = false;
let onResync: () => void = () => undefined;

/** Set by the actions module: what to do when the stream shows a gap. */
export function setResyncHandler(fn: () => void): void {
  onResync = fn;
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
    .requestAnimationFrame;
  if (raf) raf(flushNotices);
  else setTimeout(flushNotices, 16);
}

/** Applies the queued notices now (one frame's worth); exported for tests. */
export function flushNotices(): void {
  scheduled = false;
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  setData((d) => applyNotices(d, batch));
  if (enterprise.getState().data.resync) onResync();
}

/**
 * Entry point for an `enterprise.*` notification: validated here, queued for the next
 * frame. Before the view ever loaded, notices are dropped (the snapshot will be fresh).
 * Returns false for an unknown or invalid notice.
 */
export function receiveNotice(name: string, params: unknown): boolean {
  const n = parseNotice(name, params);
  if (!n) return false;
  if (holding) held.push(n);
  else if (enterprise.getState().ui.status === 'ready') {
    queue.push(n);
    schedule();
  }
  return true;
}

export function setHolding(on: boolean): void {
  holding = on;
}

/** Hands over the notices held during a snapshot (and forgets them). */
export function takeHeld(): AnyNotice[] {
  const h = held;
  held = [];
  return h;
}

/** Back to a blank store (tests, disconnect). */
export function resetEnterprise(): void {
  queue = [];
  held = [];
  scheduled = false;
  holding = false;
  enterprise.setState(initialEnt(), true);
}
