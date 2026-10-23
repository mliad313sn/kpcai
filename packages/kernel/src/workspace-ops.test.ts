import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KernelError } from './errors.js';
import { Kernel } from './kernel.js';
import { REQ, TEST_OPTIONS, recordingHost } from './test-helpers/fixture.js';
import { isGitTree } from './workspace-ops.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };

const code = (p: Promise<unknown> | (() => unknown)): Promise<string | undefined> =>
  (typeof p === 'function' ? Promise.resolve().then(p) : p).then(
    () => undefined,
    (e: unknown) => (e instanceof KernelError ? e.code : String(e)),
  );

function actions(k: Kernel, sessionId: string): unknown[] {
  return k
    .events(sessionId)
    .filter((e) => e.type === 'intervention')
    .map((e) => (e.payload as { action?: string }).action);
}

function plainFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kpai-plain-'));
  writeFileSync(join(dir, '.kernelpai-workspace'), '');
  return dir;
}

describe('workspace actions outside git', () => {
  it('auto isolation runs in place; required isolation refuses; writes go on unsnapshotted', async () => {
    const host = recordingHost(CHEAP);
    host.cwd = plainFolder();
    host.fallback = true;
    const k = new Kernel(host);
    expect(await isGitTree(host.cwd)).toBe(false);
    const auto = await k.startRun({ request: REQ, options: { ...TEST_OPTIONS, isolated: 'auto' } });
    const o = await auto.done;
    expect(o.status === 'finished' ? o.worktree : 'not run').toBeUndefined();
    const res = await k.applyPatches(auto.runId, { nodeIds: ['implementation'] });
    expect(res[0]?.ok).toBe(true);
    expect(existsSync(join(host.cwd, 'src/s.ts'))).toBe(true);
    expect(actions(k, auto.sessionId)).toEqual(
      expect.arrayContaining(['run in place', 'checkpoint unavailable']),
    );
    expect(await k.checkpoints(auto.runId)).toEqual([]);
    expect(await k.workspace.runsWithCheckpoints()).toEqual([]);

    const strict = await k.startRun({ request: REQ, options: { ...TEST_OPTIONS, isolated: true } });
    const refused = await strict.done;
    expect(refused).toMatchObject({ status: 'not_run', reason: /needs a git worktree/ });
    expect(k.runInfo(strict.runId).state).toBe('failed');
    await k.close();
  });
});

describe('workspace actions in a git repository', () => {
  it('refuses restore and merge while a run is live, and merge after a cancel', async () => {
    const host = recordingHost(CHEAP);
    let release: (v: boolean) => void = () => undefined;
    host.confirm = () => new Promise((r) => (release = r));
    host.env.KPAI_CONFIRM_ABOVE_USD = '0';
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: { ...TEST_OPTIONS, isolated: true } });
    const ref = `refs/kpai/checkpoints/${h.runId}/1`;
    expect(await code(k.restore(ref, h.runId))).toBe('refused');
    expect(await code(k.merge(h.runId))).toBe('refused');
    expect(await code(k.discard(h.runId))).toBe('refused');
    expect(await code(() => k.restore('refs/kpai/checkpoints/x/1', h.runId))).toBe('invalid');
    expect(await code(() => k.restore('nope'))).toBe('invalid');
    k.cancel(h.runId);
    release(false);
    await h.done;
    expect(await code(k.merge(h.runId))).toBe('refused');
    expect((await k.runList())[0]).toMatchObject({
      runId: h.runId,
      state: 'cancelled',
      patches: 0,
    });
    await k.close();
  });

  it('lists runs with checkpoints, restores a worktree checkpoint, refuses one discarded', async () => {
    const host = recordingHost(CHEAP);
    host.fallback = true;
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: { ...TEST_OPTIONS, isolated: true } });
    const o = await h.done;
    const wt = o.status === 'finished' ? (o.worktree as string) : '';
    await k.applyPatches(h.runId);
    expect(await k.workspace.runsWithCheckpoints()).toEqual([h.runId]);
    const cps = await k.checkpoints(h.runId);
    expect(cps.map((c) => c.where)).toEqual(['worktree', 'worktree']);
    const r = await k.restore(cps[0]?.ref as string);
    expect(r).toMatchObject({ restored: true });
    expect(existsSync(join(wt, 'src/s.ts'))).toBe(false);
    expect(await k.discard(h.runId)).toEqual({ removed: true });
    expect(await code(k.restore(cps[0]?.ref as string))).toBe('not_found');
    expect(await code(k.applyArtifacts(h.runId, { paths: ['none.md'] }))).toBe('not_found');
    expect(await code(() => k.applyArtifacts('nope'))).toBe('not_found');
    await k.close();
  });

  it('a merge with nothing to merge says so; a restore the policy denies is refused', async () => {
    const host = recordingHost(CHEAP);
    host.fallback = true;
    writeFileSync(join(host.home, 'policy.json'), JSON.stringify({ forbiddenPaths: ['src/**'] }));
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: { ...TEST_OPTIONS, isolated: true } });
    await h.done;
    expect(await k.merge(h.runId)).toEqual({
      merged: false,
      reason: 'nothing to merge',
      files: [],
      omitted: 0,
    });
    expect(await code(k.workspace.restore('refs/kpai/checkpoints/missing/1', 's'))).toBe('refused');
    await k.close();
  });
});
