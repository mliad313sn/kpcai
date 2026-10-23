/** An unreviewed document never replaces a file: at the run's end and at save time (P3-F3). */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KernelError } from './errors.js';
import { Kernel } from './kernel.js';
import { TEST_OPTIONS, recordingHost } from './test-helpers/fixture.js';

const REPORT = 'write a short report about the release';
const IN_PLACE = { ...TEST_OPTIONS, isolated: false } as const;

/** The pack plan "Sourced document", reduced to its unreviewed solo `gather` node. */
async function gatherRun(k: Kernel, options: object = IN_PLACE) {
  const plan = await k.plan(REPORT, options);
  const nodes = plan.graph.nodes
    .filter((n) => n.id === 'gather')
    .map((n) => ({ ...n, dependsOn: [] }));
  const h = await k.startRun({
    request: REPORT,
    planId: plan.planId,
    graph: { nodes },
    options,
  });
  const o = await h.done;
  if (o.status !== 'finished') throw new Error('not run');
  return { runId: h.runId, o };
}

describe('unreviewed documents never overwrite (P3-F3, kernel side)', () => {
  it('refuses at the end of the run when the file already exists in the run’s tree', async () => {
    const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100' });
    writeFileSync(join(host.cwd, 'gather.md'), 'mine\n');
    const k = new Kernel(host);
    const { o } = await gatherRun(k);
    expect(o.artifacts.map((a) => a.path)).not.toContain('gather.md');
    expect(o.refusedArtifacts).toEqual([
      expect.objectContaining({
        path: 'gather.md',
        reason: expect.stringMatching(/already exists/),
      }),
    ]);
    await k.close();
  });

  it('checks again at save time: a file created since is kept, nothing is asked', async () => {
    const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100' });
    host.fallback = true;
    const k = new Kernel(host);
    const { runId, o } = await gatherRun(k);
    expect(o.artifacts).toEqual([expect.objectContaining({ path: 'gather.md', reviewed: false })]);
    writeFileSync(join(host.cwd, 'gather.md'), 'mine\n');
    const r = await k.applyArtifacts(runId);
    expect(r).toEqual([
      expect.objectContaining({ ok: false, message: expect.stringMatching(/already exists/) }),
    ]);
    expect(host.asked.filter((a) => a.kind === 'artifact')).toEqual([]);
    expect(readFileSync(join(host.cwd, 'gather.md'), 'utf8')).toBe('mine\n');
    await k.close();
  });

  it('merge-back of an isolated run does not replace an untracked file of the workspace', async () => {
    const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100' });
    host.fallback = true;
    const k = new Kernel(host);
    const { runId, o } = await gatherRun(k, { ...TEST_OPTIONS, isolated: true });
    expect(o.worktree).toEqual(expect.any(String));
    expect(await k.applyArtifacts(runId)).toEqual([expect.objectContaining({ ok: true })]);
    // The user creates the same file in the workspace, untracked, before merging.
    writeFileSync(join(host.cwd, 'gather.md'), 'mine\n');
    const merged = await k.merge(runId).then(
      (r) => `merged ${String(r.merged)}`,
      (e: unknown) => (e instanceof KernelError ? `${e.code}: ${e.message}` : String(e)),
    );
    expect(merged).toMatch(/^refused: [\s\S]*already exists in working directory/);
    expect(readFileSync(join(host.cwd, 'gather.md'), 'utf8')).toBe('mine\n');
    await k.close();
  });
});
