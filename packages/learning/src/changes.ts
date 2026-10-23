/**
 * Changes a run delivered, read from the journal only (R-406, docs/metrics/PRODUCTIVITY.md).
 *
 * A change is one kernel write of a node's output: a patch (`git.apply`) or an artifact
 * (`fs.write`), journaled as a `tool` event under provider `kernel`. In an isolated run
 * (R-307) the write goes to the run's worktree and reaches the workspace only with the
 * run's `merge-back`; a merge with no kernel write before it (the models wrote the
 * worktree through their tools) counts as one change of kind `merge`.
 *
 * Then, across the project: a change is rolled back when a workspace checkpoint restore
 * that wrote or deleted files went back to a checkpoint taken before the change landed;
 * it is reworked when it was rolled back, or when a later run's accepted change touched
 * one of its files within the rework window.
 */
import type { JournalEvent } from '@kernelpai/journal';
import type { RunRecord } from './runs.js';
import { ACTIONS } from './signals.js';

export type ChangeKind = 'patch' | 'artifact' | 'merge';

/**
 * - accepted: reached the workspace (applied in place, or merged back);
 * - declined: the human said no to the write or to the run's merge-back;
 * - failed: refused by the tool bus (zones, jail, hidden bytes) or did not apply;
 * - pending: applied in an isolated run's worktree, neither merged nor discarded yet;
 * - discarded: applied in a worktree that was discarded without a merge.
 */
export type ChangeStatus = 'accepted' | 'declined' | 'failed' | 'pending' | 'discarded';

export interface Change {
  runKey: string;
  nodeId: string;
  kind: ChangeKind;
  /** Workspace-relative files it touched (patch `meta.files`, artifact path, merge files). */
  files: string[];
  /** Journal sequence of the write (or of the merge for kind `merge`). */
  seq: number;
  status: ChangeStatus;
  /** When it reached the workspace: the write itself, or the run's merge-back. */
  landed?: { seq: number; ts: string };
  /** The restore that undid it. */
  rolledBackSeq?: number;
  /** The later change (sequence) that touched one of its files again. */
  reworkedSeq?: number;
}

/** Interventions this module reads, besides `ACTIONS`. */
export const CHANGE_ACTIONS = {
  worktree: 'worktree created',
  merge: 'merge-back',
  discarded: 'worktree discarded',
} as const;

const WRITE_TOOLS: Readonly<Record<string, ChangeKind>> = {
  'git.apply': 'patch',
  'fs.write': 'artifact',
};
const OK = new Set(['allow', 'confirmed']);
const WRITE_NODE = /#(patch|artifact)-\d+$/;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const action = (e: JournalEvent): string | undefined =>
  e.type === 'intervention' ? str(e.payload.action) : undefined;

/** A kernel write of a node's patch or artifact (not a model's own tool call). */
export function isKernelWrite(e: JournalEvent): boolean {
  return (
    e.type === 'tool' &&
    e.provider === 'kernel' &&
    WRITE_NODE.test(e.nodeId ?? '') &&
    str(e.payload.tool) !== undefined &&
    WRITE_TOOLS[str(e.payload.tool) as string] !== undefined
  );
}

function filesOf(e: JournalEvent): string[] {
  const meta = (e.payload.meta ?? {}) as { files?: unknown };
  const input = (e.payload.input ?? {}) as { path?: unknown };
  const path = str(input.path);
  return e.payload.tool === 'fs.write' && path ? [path] : strings(meta.files);
}

function writeStatus(e: JournalEvent): ChangeStatus | 'applied' {
  const decision = str(e.payload.decision) ?? '';
  if (OK.has(decision)) return e.payload.isError === true ? 'failed' : 'applied';
  return decision === 'declined' ? 'declined' : 'failed';
}

/** What became of an isolated run's applied write: the first merge decision after it. */
function isolatedFate(
  write: JournalEvent,
  ends: readonly JournalEvent[],
): Pick<Change, 'status' | 'landed'> {
  const end = ends.find((x) => x.seq > write.seq);
  const a = end && action(end);
  if (!end || !a) return { status: 'pending' };
  if (a === CHANGE_ACTIONS.merge)
    return { status: 'accepted', landed: { seq: end.seq, ts: end.ts } };
  return { status: a === ACTIONS.mergeDeclined ? 'declined' : 'discarded' };
}

/** The changes of one run, in journal order. */
export function runChanges(run: RunRecord): Change[] {
  const all = [...run.events, ...run.after].sort((a, b) => a.seq - b.seq);
  const isolated = all.some((e) => action(e) === CHANGE_ACTIONS.worktree);
  const ends = all.filter((e) => {
    const a = action(e);
    return (
      a === CHANGE_ACTIONS.merge || a === ACTIONS.mergeDeclined || a === CHANGE_ACTIONS.discarded
    );
  });
  const out: Change[] = [];
  for (const e of all.filter(isKernelWrite)) {
    const base = {
      runKey: run.key,
      nodeId: (e.nodeId ?? '').replace(WRITE_NODE, ''),
      kind: WRITE_TOOLS[e.payload.tool as string] as ChangeKind,
      files: filesOf(e),
      seq: e.seq,
    };
    const s = writeStatus(e);
    if (s !== 'applied') out.push({ ...base, status: s });
    else if (!isolated) out.push({ ...base, status: 'accepted', landed: { seq: e.seq, ts: e.ts } });
    else out.push({ ...base, ...isolatedFate(e, ends) });
  }
  return [...out, ...bareMerges(run, ends, out)];
}

/** A merge-back with no kernel write landing through it: the worktree as one change. */
function bareMerges(run: RunRecord, ends: readonly JournalEvent[], writes: Change[]): Change[] {
  const out: Change[] = [];
  for (const m of ends.filter((e) => action(e) === CHANGE_ACTIONS.merge)) {
    if (writes.some((w) => w.landed?.seq === m.seq)) continue;
    out.push({
      runKey: run.key,
      nodeId: '',
      kind: 'merge',
      files: strings(m.payload.files),
      seq: m.seq,
      status: 'accepted',
      landed: { seq: m.seq, ts: m.ts },
    });
  }
  return out;
}

export interface RollbackScan {
  /** Workspace restores whose checkpoint is not in the journal read: not attributed. */
  unattributed: number;
}

/**
 * Marks the accepted changes undone by a workspace restore. `events` are every event of
 * the project (checkpoints and restores of any run). A restore that wrote and deleted
 * nothing undid nothing; a worktree checkpoint (`…-wt/…`) never touches the workspace.
 */
export function markRollbacks(changes: Change[], events: readonly JournalEvent[]): RollbackScan {
  const checkpoints = new Map<string, number>();
  let unattributed = 0;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const a = action(e);
    const ref = str(e.payload.ref) ?? '';
    if (a === ACTIONS.checkpoint && ref) checkpoints.set(ref, e.seq);
    if (a !== ACTIONS.restore || /-wt\//.test(ref)) continue;
    const touched = Number(e.payload.written ?? 0) + Number(e.payload.deleted ?? 0);
    if (!(touched > 0)) continue;
    const from = checkpoints.get(ref);
    if (from === undefined) {
      unattributed += 1;
      continue;
    }
    for (const c of changes) {
      const at = c.landed?.seq;
      if (c.status !== 'accepted' || at === undefined || c.rolledBackSeq !== undefined) continue;
      if (at > from && at < e.seq) c.rolledBackSeq = e.seq;
    }
  }
  return { unattributed };
}

/**
 * Marks accepted changes touched again by a later run's accepted change within
 * `windowMs` (same file, workspace-relative). Rolled-back changes are already rework.
 */
export function markRework(changes: Change[], windowMs: number): void {
  const landed = changes
    .filter((c) => c.status === 'accepted' && c.landed)
    .sort((a, b) => (a.landed?.seq ?? 0) - (b.landed?.seq ?? 0));
  for (const [i, x] of landed.entries()) {
    const files = new Set(x.files);
    if (files.size === 0) continue;
    const t0 = Date.parse(x.landed?.ts ?? '');
    const later = landed.slice(i + 1).find((y) => {
      if (y.runKey === x.runKey || !y.files.some((f) => files.has(f))) return false;
      const dt = Date.parse(y.landed?.ts ?? '') - t0;
      return Number.isFinite(dt) && dt <= windowMs;
    });
    if (later?.landed) x.reworkedSeq = later.landed.seq;
  }
}
