/**
 * R-305 / R-307 at the kernel boundary (ADR-0021): checkpoints before every write to a
 * tree, restore and merge-back as confirmed actions, one worktree per isolated run.
 * Built on the workspace API of `@kernelpai/tools`; every action is journaled.
 *
 * Checkpoint namespaces: `<runId>` holds checkpoints of the user's workspace (in-place runs,
 * and the one taken before a merge-back); `<runId>-wt` holds those of the run's worktree.
 * A ref therefore says by itself which tree it restores.
 */
import { execFile } from 'node:child_process';
import type { ModelRef, PermissionPolicy } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import {
  checkpoint,
  createRunWorktree,
  diffRunWorktree,
  listCheckpoints,
  locateRunWorktree,
  mergeBack,
  removeRunWorktree,
  restore,
  ToolError,
  type Gate,
  type PackZoneOptions,
  type RunWorktree,
  type WorkspaceOptions,
} from '@kernelpai/tools';
import type { Confirm } from './confirm.js';
import { kpaiHome, type Env } from './env.js';
import { KernelError } from './errors.js';
import { policyFor } from './packs.js';

export const WT_SUFFIX = '-wt';
const REF = /^refs\/kpai\/checkpoints\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/([1-9]\d{0,8})$/;

export interface CheckpointInfo {
  ref: string;
  runId: string;
  n: number;
  label: string;
  createdAt: string;
  commit: string;
  /** The tree it restores: the user's workspace or the run's worktree. */
  where: 'workspace' | 'worktree';
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export interface WorkspaceHost {
  env: Env;
  cwd: string;
  journal: () => Journal;
  confirm: Confirm;
  say(text: string): void;
}

/** True when root is inside a git working tree. */
export function isGitTree(root: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root }, (err, out) =>
      resolve(!err && String(out).trim() === 'true'),
    );
  });
}

function parseRef(ref: string): { ns: string; runId: string; worktree: boolean } {
  const m = REF.exec(ref);
  if (!m) throw new KernelError('invalid', `not a checkpoint ref: ${ref.slice(0, 200)}`);
  const ns = m[1] as string;
  const worktree = ns.endsWith(WT_SUFFIX);
  return { ns, runId: worktree ? ns.slice(0, -WT_SUFFIX.length) : ns, worktree };
}

/** ToolErrors become kernel refusals (the message is safe to show). */
async function guarded<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof ToolError) throw new KernelError('refused', err.message);
    throw err;
  }
}

export class WorkspaceOps {
  constructor(private readonly h: WorkspaceHost) {}

  /** Policy and zones in force; `extra` are domain-pack additions (they only tighten). */
  private async opts(
    packs?: PackZoneOptions,
  ): Promise<WorkspaceOptions & { policy: PermissionPolicy }> {
    // Relaxations of approved packs are journaled before they apply (S7, fail closed).
    const journal = packs ? this.h.journal() : undefined;
    const { policy } = await policyFor(this.h.env, packs, journal, this.h.cwd);
    return { home: kpaiHome(this.h.env), zones: policy.zoneSet(), policy };
  }

  private note(sessionId: string, payload: Record<string, unknown>): void {
    this.h.journal().append({ sessionId, type: 'intervention', payload });
  }

  private gate(
    policy: PermissionPolicy,
    root: string,
    sessionId: string,
    ask: Gate['ctx']['confirm'],
  ): Gate {
    const model: ModelRef = { provider: 'kernel', model: 'workspace' };
    return { policy, ctx: { model, root, sessionId, nodeId: 'workspace', confirm: ask } };
  }

  /** A fresh worktree for an isolated run (refs `refs/kpai/runs/<runId>/…`). */
  async createWorktree(runId: string): Promise<RunWorktree> {
    const o = await this.opts();
    return guarded(() => createRunWorktree(this.h.cwd, runId, o));
  }

  /**
   * Snapshot of `root` before a write, journaled. Outside git there is nothing to
   * snapshot: the write goes on (it is still confirmed) and the gap is journaled.
   * Any other failure throws: no checkpoint, no write.
   */
  async before(
    root: string,
    ns: string,
    label: string,
    sessionId: string,
  ): Promise<string | undefined> {
    // The run id names the run the write that follows belongs to (learning, R-406).
    const runId = ns.replace(/-wt$/, '');
    if (!(await isGitTree(root))) {
      this.note(sessionId, {
        action: 'checkpoint unavailable',
        runId,
        reason: 'not a git repository',
        label,
      });
      return undefined;
    }
    const o = await this.opts();
    const c = await guarded(() => checkpoint(root, label, { ...o, run: ns }));
    this.note(sessionId, {
      action: 'checkpoint',
      runId,
      ref: c.ref,
      label: c.label,
    });
    return c.ref;
  }

  /** Checkpoints of one run, workspace ones first, each oldest first. */
  async list(runId: string): Promise<CheckpointInfo[]> {
    if (!(await isGitTree(this.h.cwd))) return [];
    const o = await this.opts();
    const out: CheckpointInfo[] = [];
    for (const [ns, where] of [
      [runId, 'workspace'],
      [runId + WT_SUFFIX, 'worktree'],
    ] as const) {
      const list = await guarded(() => listCheckpoints(this.h.cwd, ns, o));
      for (const c of list) out.push({ ...c, runId, where, ref: c.ref });
    }
    return out.map(({ ref, runId: r, n, label, createdAt, commit, where }) => ({
      ref,
      runId: r,
      n,
      label,
      createdAt,
      commit,
      where,
    }));
  }

  /** Run ids that have checkpoints in this repository. */
  async runsWithCheckpoints(): Promise<string[]> {
    if (!(await isGitTree(this.h.cwd))) return [];
    const out = await new Promise<string>((resolve) =>
      execFile(
        'git',
        ['for-each-ref', '--format=%(refname)', 'refs/kpai/checkpoints/'],
        { cwd: this.h.cwd, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => resolve(err ? '' : String(stdout)),
      ),
    );
    const ids = out
      .split(/\r?\n/)
      .map((l) => REF.exec(l.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => (m[1] as string).replace(/-wt$/, ''));
    return [...new Set(ids)];
  }

  /**
   * Restores a checkpoint, in the tree it was taken from. Destructive: the policy decides,
   * then the human confirms (`restore` kind); no answer is a no. Journaled either way.
   */
  async restore(
    ref: string,
    sessionId: string,
    packs?: PackZoneOptions,
  ): Promise<
    | { restored: true; written: string[]; deleted: string[]; skipped: number; undo: string }
    | { restored: false; reason: string }
  > {
    const { runId, worktree } = parseRef(ref);
    const o = await this.opts(packs);
    const root = worktree
      ? (
          await guarded(() => locateRunWorktree(this.h.cwd, runId, o)).catch(() => {
            throw new KernelError('not_found', `the worktree of run ${runId} was discarded`);
          })
        ).root
      : this.h.cwd;
    const ask = (question: string): Promise<boolean> =>
      this.h.confirm({ kind: 'restore', question, risk: 'destructive', runId });
    try {
      const r = await restore(root, ref, this.gate(o.policy, root, sessionId, ask), o);
      this.note(sessionId, {
        action: 'restore',
        runId,
        ref,
        undo: r.undo,
        written: r.written.length,
        deleted: r.deleted.length,
        skipped: r.skipped,
      });
      return {
        restored: true,
        written: r.written,
        deleted: r.deleted,
        skipped: r.skipped,
        undo: r.undo,
      };
    } catch (err) {
      return this.declined(err, sessionId, { action: 'restore declined', runId, ref });
    }
  }

  private declined(
    err: unknown,
    sessionId: string,
    payload: Record<string, unknown>,
  ): { restored: false; merged: false; reason: string } {
    if (!(err instanceof ToolError)) throw err;
    if (!/^permission declined/.test(err.message)) throw new KernelError('refused', err.message);
    this.note(sessionId, payload);
    return { restored: false, merged: false, reason: 'declined by the user' };
  }

  /** The run worktree's changes, zone-filtered; undefined when it has no worktree. */
  async diff(
    runId: string,
    packs?: PackZoneOptions,
  ): Promise<{ diff: string; files: string[]; stats: DiffStats } | undefined> {
    const o = await this.opts(packs);
    const d = await diffRunWorktree(this.h.cwd, runId, o).catch(() => undefined);
    if (!d) return undefined;
    const lines = d.diff.split('\n');
    const additions = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const deletions = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    return { diff: d.diff, files: d.files, stats: { files: d.files.length, additions, deletions } };
  }

  /**
   * Merges an isolated run back into the workspace: a confirmed write (`patch` kind with
   * the whole diff), preceded by a workspace checkpoint once the human said yes.
   */
  async merge(
    runId: string,
    sessionId: string,
    packs?: PackZoneOptions,
  ): Promise<
    | { merged: true; files: string[]; omitted: number; checkpoint?: string }
    | { merged: false; reason: string; files: string[]; omitted: number }
  > {
    const o = await this.opts(packs);
    const shown = await this.diff(runId, packs);
    if (!shown) throw new KernelError('not_found', `no worktree for run ${runId}`);
    let saved: string | undefined;
    const ask = async (question: string): Promise<boolean> => {
      const yes = await this.h.confirm({
        kind: 'patch',
        question,
        patch: shown.diff,
        risk: 'write',
        runId,
      });
      if (!yes) return false;
      // No checkpoint, no write (a non-git workspace cannot hold an isolated run).
      saved = await this.before(this.h.cwd, runId, `before merge of run ${runId}`, sessionId).catch(
        () => 'failed',
      );
      return saved !== 'failed';
    };
    try {
      const r = await mergeBack(
        this.h.cwd,
        runId,
        this.gate(o.policy, this.h.cwd, sessionId, ask),
        o,
      );
      if (!r.applied)
        return { merged: false, reason: 'nothing to merge', files: [], omitted: r.omitted };
      this.note(sessionId, { action: 'merge-back', runId, files: r.files, checkpoint: saved });
      return {
        merged: true,
        files: r.files,
        omitted: r.omitted,
        ...(saved ? { checkpoint: saved } : {}),
      };
    } catch (err) {
      const d = this.declined(err, sessionId, { action: 'merge-back declined', runId });
      return { merged: false, reason: d.reason, files: shown.files, omitted: 0 };
    }
  }

  /** Removes an isolated run's worktree (its checkpoints stay). Journaled. */
  async discard(runId: string, sessionId: string): Promise<{ removed: boolean }> {
    const o = await this.opts();
    const r = await guarded(() => removeRunWorktree(this.h.cwd, runId, o));
    this.note(sessionId, { action: 'worktree discarded', runId, removed: r.removed });
    return r;
  }
}
