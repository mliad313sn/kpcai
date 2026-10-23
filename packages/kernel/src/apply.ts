import type { Journal } from '@kernelpai/journal';
import { createToolBus, type LocalToolBus, type PackZoneOptions } from '@kernelpai/tools';
import { unreviewedOverwrite, type Artifact } from './artifacts.js';
import type { Confirm } from './confirm.js';
import { kpaiHome } from './env.js';
import { busZones } from './extensions/hook-bus.js';
import { runHooks } from './extensions/hook-run.js';
import { loadHooks } from './extensions/hooks.js';
import { homeZones } from './home-zone.js';
import type { Patch } from './patches.js';
import { busPacks } from './packs.js';
import { inWorktree, physicalPacks } from './sources.js';
import type { ApplyResult, ArtifactApplyResult, KernelHost, Plan } from './types.js';
import { WT_SUFFIX, type WorkspaceOps } from './workspace-ops.js';

export interface ApplyContext {
  host: KernelHost;
  journal: Journal;
  confirm: Confirm;
  sessionId: string;
  runId: string;
  /** Where the writes go: the workspace, or the run's worktree when isolated (R-307). */
  root: string;
  /** Snapshot before each write (R-305); throws when one cannot be taken. */
  checkpoint(label: string): Promise<unknown>;
  /** The run's domain packs: their zones bind these writes too (S7's bus option). */
  packs?: PackZoneOptions;
  /** Approve the git.apply write without asking (separate from `yes`, review P2-F15). */
  yesApply?: boolean;
  /** A selected pack has physical effects (D-019): said on each confirmation (D-028). */
  physical?: boolean;
}

/** D-028 facts of every write confirmation of this context. */
function facts(c: ApplyContext): { inWorktree: boolean; physical: boolean } {
  return { inWorktree: inWorktree(c.root, c.host.cwd), physical: c.physical === true };
}

/**
 * Writes go to the run's tree, each after a checkpoint of that tree (R-305, R-307), under
 * the run's pack zones.
 */
export function runApplyContext(
  base: Pick<ApplyContext, 'host' | 'journal' | 'confirm'> & {
    workspace: Pick<WorkspaceOps, 'before'>;
  },
  run: { runId: string; workRoot?: string; plan: Pick<Plan, 'sessionId' | 'packs'> },
  yesApply: boolean | undefined,
): ApplyContext {
  const root = run.workRoot ?? base.host.cwd;
  const ns = run.workRoot ? run.runId + WT_SUFFIX : run.runId;
  const sessionId = run.plan.sessionId;
  return {
    host: base.host,
    journal: base.journal,
    confirm: base.confirm,
    sessionId,
    runId: run.runId,
    root,
    checkpoint: (label) => base.workspace.before(root, ns, label, sessionId),
    packs: busPacks(run.plan.packs, sessionId),
    ...(physicalPacks(run.plan.packs.selected) ? { physical: true } : {}),
    ...(yesApply ? { yesApply: true } : {}),
  };
}

async function withBus<T>(c: ApplyContext, f: (bus: LocalToolBus) => Promise<T>): Promise<T> {
  const { bus } = await createToolBus({
    kpaiHome: kpaiHome(c.host.env),
    // $KPAI_HOME/memory/** when the home is inside the workspace (ADR-0030).
    policyOptions: { forbiddenPaths: homeZones(c.host.env, c.host.cwd) },
    journal: c.journal,
    env: c.host.env,
    ...(c.packs ? { packs: c.packs } : {}),
  });
  try {
    return await f(bus);
  } finally {
    await bus.close();
  }
}

/** A checkpoint first; when it fails nothing is written (R-305). */
async function snapshot(c: ApplyContext, label: string): Promise<string | undefined> {
  try {
    await c.checkpoint(label);
    return undefined;
  } catch (err) {
    return `not applied: no checkpoint could be taken (${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * Applies patches through the tool bus (`git.apply`: jailed, checked, forbidden zones of
 * `$KPAI_HOME/policy.json` included), each after a checkpoint of the target tree. Each
 * write is confirmed with the exact patch unless `yesApply`, one question per patch even
 * when a node produced several (P3-F1); the caller has already checked
 * that the patches are critic-approved, hidden-byte-free and that the run was not cancelled.
 */
export function applyAll(c: ApplyContext, patches: Patch[]): Promise<ApplyResult[]> {
  return withBus(c, async (bus) => {
    const results: ApplyResult[] = [];
    for (const [i, p] of patches.entries()) {
      const stop = await snapshot(c, `before patch from ${p.nodeId}`);
      if (stop) {
        results.push({ nodeId: p.nodeId, ok: false, message: stop.slice(0, 300) });
        continue;
      }
      const r = await bus.call(
        { id: `apply-${p.nodeId}-${i}`, name: 'git.apply', input: { patch: p.patch } },
        {
          model: { provider: 'kernel', model: 'apply' },
          root: c.root,
          sessionId: c.sessionId,
          // Each patch is its own write batch: a node with two diffs is asked twice, each
          // time with the diff that will be written (review P3-F1).
          nodeId: `${p.nodeId}#patch-${i}`,
          confirm: (question) =>
            c.yesApply
              ? Promise.resolve(true)
              : c.confirm({
                  kind: 'patch',
                  question,
                  patch: p.patch,
                  risk: 'write',
                  runId: c.runId,
                  ...facts(c),
                }),
        },
      );
      const result = { nodeId: p.nodeId, ok: !r.isError, message: r.content.slice(0, 300) };
      results.push(r.isError ? result : await afterPatch(c, bus, p, i, result));
    }
    return results;
  });
}

/**
 * Writes artifacts with `fs.write` (jailed, forbidden zones, confirmed), each after a
 * checkpoint. Each artifact is its own write batch, so each one is confirmed with its exact
 * content; `yesApply` approves reviewed ones as it approves patches. A document no critic
 * reviewed is asked about first, on its own, every time, and `yesApply` never covers it.
 */
export function applyArtifacts(c: ApplyContext, list: Artifact[]): Promise<ArtifactApplyResult[]> {
  return withBus(c, async (bus) => {
    const results: ArtifactApplyResult[] = [];
    for (const [i, a] of list.entries()) {
      const done = (ok: boolean, message: string): number =>
        results.push({ path: a.path, nodeId: a.nodeId, ok, message: message.slice(0, 300) });
      const ask = artifactAsk(c, a);
      // Checked again at save time: the file may have appeared since the run ended (P3-F3).
      const taken = a.reviewed ? undefined : unreviewedOverwrite(c.root, a.path);
      if (taken) {
        done(false, taken);
        continue;
      }
      if (!a.reviewed && !(await ask(`save ${a.path} (${a.kind}, NOT REVIEWED by a critic)?`))) {
        done(false, 'not saved: declined by the user (not reviewed)');
        continue;
      }
      const stop = await snapshot(c, `before artifact ${a.path}`);
      if (stop) {
        done(false, stop);
        continue;
      }
      const r = await bus.call(
        { id: `artifact-${i}`, name: 'fs.write', input: { path: a.path, content: a.content } },
        {
          model: { provider: 'kernel', model: 'artifact' },
          root: c.root,
          sessionId: c.sessionId,
          nodeId: `${a.nodeId}#artifact-${i}`,
          // The unreviewed case was asked above with this exact content.
          confirm: (question) =>
            !a.reviewed || c.yesApply ? Promise.resolve(true) : ask(question),
        },
      );
      done(!r.isError, r.content);
    }
    return results;
  });
}

function artifactAsk(c: ApplyContext, a: Artifact): (question: string) => Promise<boolean> {
  const meta = {
    path: a.path,
    kind: a.kind,
    mime: a.mime,
    bytes: a.bytes,
    nodeId: a.nodeId,
    reviewed: a.reviewed,
  };
  return (question) =>
    c.confirm({
      kind: 'artifact',
      question,
      content: a.content,
      artifact: meta,
      risk: 'write',
      runId: c.runId,
      ...facts(c),
    });
}

/**
 * R-502: `after-patch` hooks run once a patch is written, through the same bus (confirmed
 * unless allow-listed). They cannot undo the write; their untrusted output is reported.
 */
async function afterPatch(
  c: ApplyContext,
  bus: LocalToolBus,
  p: Patch,
  i: number,
  result: ApplyResult,
): Promise<ApplyResult> {
  const hooks = await loadHooks(kpaiHome(c.host.env), c.host.cwd, busZones(bus));
  if (!hooks.hooks.some((h) => h.event === 'after-patch')) return result;
  const data = { runId: c.runId, nodeId: p.nodeId, files: p.files };
  const v = await runHooks(bus, hooks, 'after-patch', data, {
    root: c.root,
    sessionId: c.sessionId,
    nodeId: `${p.nodeId}#patch-${i}`,
    env: c.host.env,
    confirm: (question) =>
      c.confirm({ kind: 'tool', question, risk: 'destructive', runId: c.runId, ...facts(c) }),
  });
  for (const h of v.runs)
    if (!h.ok) c.host.say?.(`  – after-patch hook ${h.name} failed: ${h.output.split('\n')[0]}\n`);
  return { ...result, hooks: v.runs.map((h) => ({ name: h.name, ok: h.ok })) };
}
