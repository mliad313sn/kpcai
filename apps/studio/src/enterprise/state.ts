/**
 * Pure state of the Enterprise view are stored as they come (R-5E10): a snapshot, then `enterprise.*` notifications
 * applied in `seq` order (one sequence for the whole stream). A notification at or below
 * the cursor is a duplicate and ignored; a gap, or an open escalation the client has no
 * text for, asks for a new snapshot (`resync`) instead of guessing.
 */
import type {
  Activity,
  AnyNotice,
  EnterpriseSnapshot,
  Gauge,
  Heartbeat,
  InboxItem,
  Notice,
  ProgramCard,
  QueueEntry,
  ReportEntry,
  ResultEntry,
  SeatView,
  WpState,
} from './schemas';

/** Feed lines kept in memory; the daemon's journal has every one. */
export const MAX_ACTIVITY = 5000;
export const MAX_REPORTS = 500;

/** A program card, plus the work packages the client saw move (`enterprise.wp`). */
export type ProgramView = ProgramCard & { wps?: Array<{ wpId: string; state: WpState }> };

export interface EntState {
  loaded: boolean;
  at?: string;
  killSwitch: boolean;
  cursor: number;
  programs: ProgramView[];
  seats: SeatView[];
  gauges: Gauge[];
  /** Open escalations only; answered or expired ones leave the inbox. */
  inbox: InboxItem[];
  /** Newest first. */
  activity: Activity[];
  /** Newest first. */
  reports: ReportEntry[];
  /** Delivered runs and their assurance label (S10 R5). */
  results: ResultEntry[];
  queue: QueueEntry[];
  heartbeat?: Heartbeat;
  rubberStamp?: EnterpriseSnapshot['rubberStamp'];
  /** A gap in `seq` or an escalation without text: the client should snapshot again. */
  resync: boolean;
}

export function emptyState(): EntState {
  return {
    loaded: false,
    killSwitch: false,
    cursor: 0,
    programs: [],
    seats: [],
    gauges: [],
    inbox: [],
    activity: [],
    reports: [],
    results: [],
    queue: [],
    resync: false,
  };
}

export const seatKey = (s: { programId: string; seatId: string }): string =>
  `${s.programId}/${s.seatId}`;
export const gaugeKey = (g: { scope: string; id: string }): string => `${g.scope}:${g.id}`;

const byNewest = <T extends { at?: string }>(a: T, b: T): number =>
  (b.at ?? '').localeCompare(a.at ?? '');

/** A snapshot replaces everything but the feed, which is only streamed (and backfilled). */
export function fromSnapshot(snap: EnterpriseSnapshot, previous?: EntState): EntState {
  const wps = new Map((previous?.programs ?? []).map((p) => [p.programId, p.wps]));
  return {
    loaded: true,
    at: snap.at,
    killSwitch: snap.killSwitch,
    cursor: snap.cursor,
    programs: snap.programs.map((p) => {
      const known = wps.get(p.programId);
      return known ? { ...p, wps: known } : p;
    }),
    seats: snap.seats,
    gauges: snap.gauges,
    inbox: snap.inbox,
    activity: (previous?.activity ?? []).filter((a) => a.seq <= snap.cursor),
    reports: [...(snap.reports ?? previous?.reports ?? [])].sort(byNewest),
    results: snap.results ?? [],
    queue: snap.queue ?? [],
    ...(snap.heartbeat ? { heartbeat: snap.heartbeat } : {}),
    ...(snap.rubberStamp ? { rubberStamp: snap.rubberStamp } : {}),
    resync: false,
  };
}

/** Feed lines from `enterprise.activity` (backfill): merged by `seq`, newest first. */
export function withActivity(s: EntState, items: readonly Activity[]): EntState {
  const seen = new Set(s.activity.map((a) => a.seq));
  const merged = [...s.activity, ...items.filter((a) => !seen.has(a.seq))];
  return { ...s, activity: merged.sort((a, b) => b.seq - a.seq).slice(0, MAX_ACTIVITY) };
}

function upsert<T>(list: T[], item: T, key: (x: T) => string): T[] {
  const k = key(item);
  const i = list.findIndex((x) => key(x) === k);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function withWp(prog: ProgramView, wpId: string, state: WpState): ProgramView {
  return { ...prog, wps: upsert(prog.wps ?? [], { wpId, state }, (w) => w.wpId) };
}

/** A work package moves between seats: the `to` seat holds it, `from` lets it go. */
function onWp(s: EntState, p: Notice<'enterprise.wp'>): Partial<EntState> {
  const seats = s.seats.map((seat) => {
    if (seat.programId !== p.programId) return seat;
    if (seat.seatId === p.to) return { ...seat, wpId: p.wpId };
    if (seat.seatId === p.from && seat.wpId === p.wpId) {
      const rest = { ...seat };
      delete rest.wpId;
      return rest;
    }
    return seat;
  });
  const programs = s.programs.map((prog) =>
    prog.programId === p.programId ? withWp(prog, p.wpId, p.state) : prog,
  );
  return { seats, programs };
}

function onProgram(s: EntState, p: Notice<'enterprise.program'>): Partial<EntState> {
  const card: ProgramView = p;
  const old = s.programs.find((x) => x.programId === card.programId);
  const merged = old?.wps ? { ...card, wps: old.wps } : card;
  return { programs: upsert(s.programs, merged, (x) => x.programId) };
}

function onInbox(s: EntState, p: Notice<'enterprise.inbox'>): Partial<EntState> {
  const known = s.inbox.some((i) => i.escalationId === p.escalationId);
  if (p.state === 'open') return known ? {} : { resync: true };
  return { inbox: s.inbox.filter((i) => i.escalationId !== p.escalationId) };
}

function onReport(s: EntState, p: Notice<'enterprise.report'>): Partial<EntState> {
  if (s.reports.some((r) => r.reportId === p.reportId)) return {};
  return { reports: [p, ...s.reports].slice(0, MAX_REPORTS) };
}

function apply(s: EntState, n: AnyNotice): Partial<EntState> {
  switch (n.name) {
    case 'enterprise.seat':
      return { seats: upsert<SeatView>(s.seats, n.params, seatKey) };
    case 'enterprise.wp':
      return onWp(s, n.params);
    case 'enterprise.program':
      return onProgram(s, n.params);
    case 'enterprise.gauge':
      return { gauges: upsert<Gauge>(s.gauges, n.params, gaugeKey) };
    case 'enterprise.activity':
      return { activity: [n.params, ...s.activity].slice(0, MAX_ACTIVITY) };
    case 'enterprise.inbox':
      return onInbox(s, n.params);
    case 'enterprise.report':
      return onReport(s, n.params);
    case 'enterprise.heartbeat':
      return { heartbeat: n.params };
  }
}

/** Applies one validated notification; duplicates are ignored, gaps flag a resync. */
export function applyNotice(s: EntState, n: AnyNotice): EntState {
  const seq = n.params.seq;
  if (s.loaded && seq <= s.cursor) return s;
  const gap = s.loaded && seq > s.cursor + 1;
  const next = { ...s, ...apply(s, n), cursor: Math.max(s.cursor, seq) };
  return gap ? { ...next, resync: true } : next;
}

/** Applies a batch (one animation frame's worth) in arrival order. */
export function applyNotices(s: EntState, batch: readonly AnyNotice[]): EntState {
  let next = s;
  for (const n of batch) next = applyNotice(next, n);
  return next;
}

/** The client answered (or saw answered) an escalation: it leaves the inbox at once. */
export function withoutEscalation(s: EntState, escalationId: string): EntState {
  return { ...s, inbox: s.inbox.filter((i) => i.escalationId !== escalationId) };
}

/** The Sponsor opened an ask's evidence: the kernel records it, the card says so. */
export function markViewed(s: EntState, escalationId: string): EntState {
  return {
    ...s,
    inbox: s.inbox.map((i) => (i.escalationId === escalationId ? { ...i, viewed: true } : i)),
  };
}
