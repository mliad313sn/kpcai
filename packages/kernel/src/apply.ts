import type { Journal } from '@kernelpai/journal';
import { createToolBus, type LocalToolBus, type PackZoneOptions } from '@kernelpai/tools';
import type { Artifact } from './artifacts.js';
import type { Confirm } from './confirm.js';
import { kpaiHome } from './env.js';
import type { Patch } from './patches.js';
import type { ApplyResult, ArtifactApplyResult, KernelHost } from './types.js';

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
}

async function withBus<T>(c: ApplyContext, f: (bus: LocalToolBus) => Promise<T>): Promise<T> {
  const { bus } = await createToolBus({
    kpaiHome: kpaiHome(c.host.env),
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
 * write is confirmed with the exact patch unless `yesApply`; the caller has already checked
 * that the patches are critic-approved, hidden-byte-free and that the run was not cancelled.
 */
export function applyAll(c: ApplyContext, patches: Patch[]): Promise<ApplyResult[]> {
  return withBus(c, async (bus) => {
    const results: ApplyResult[] = [];
    for (const p of patches) {
      const stop = await snapshot(c, `before patch from ${p.nodeId}`);
      if (stop) {
        results.push({ nodeId: p.nodeId, ok: false, message: stop.slice(0, 300) });
        continue;
      }
      const r = await bus.call(
        { id: `apply-${p.nodeId}`, name: 'git.apply', input: { patch: p.patch } },
        {
          model: { provider: 'kernel', model: 'apply' },
          root: c.root,
          sessionId: c.sessionId,
          nodeId: p.nodeId,
          confirm: (question) =>
            c.yesApply
              ? Promise.resolve(true)
              : c.confirm({
                  kind: 'patch',
                  question,
                  patch: p.patch,
                  risk: 'write',
                  runId: c.runId,
                }),
        },
      );
      results.push({ nodeId: p.nodeId, ok: !r.isError, message: r.content.slice(0, 300) });
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
    });
}
