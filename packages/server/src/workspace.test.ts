/**
 * R-305 / R-306 / R-307 and D-019 over the real protocol: a WebSocket client, temp git
 * repositories, mock providers, no network.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaseAdapter, type ChatRequest } from '@kernelpai/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REQ, recordingHost } from '../../kernel/src/test-helpers/fixture.js';
import { startServer, type KernelServer } from './server.js';
import { connect, type Note, type TestClient } from './test-helpers/client.js';

const servers: KernelServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };
const IN_PLACE = { allowTest: true, isolated: false };

async function boot(files: Record<string, string> = {}, confirmTimeoutMs = 3000) {
  const host = recordingHost(CHEAP);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(host.cwd, rel, '..'), { recursive: true });
    writeFileSync(join(host.cwd, rel), text);
  }
  const server = await startServer({
    kernel: { env: host.env, cwd: host.cwd },
    confirmTimeoutMs,
    serverFile: false,
  });
  servers.push(server);
  const c = await connect(`ws://127.0.0.1:${server.port}/rpc`, { token: server.token });
  clients.push(c);
  return { host, c };
}

/** Answers confirmations of these kinds with yes; others are left unanswered. */
function answer(c: TestClient, kinds: string[], seen: Note[] = []): Note[] {
  c.onNote = (n) => {
    if (n.method !== 'confirm.request') return;
    seen.push(n);
    if (kinds.includes(String(n.params.kind)))
      void c.call('confirm.answer', { confirmId: n.params.confirmId, ok: true });
  };
  return seen;
}

async function run(c: TestClient, request: string, options: Record<string, unknown>) {
  const start = await c.call('run.start', { request, options });
  const { runId } = start.result as { runId: string };
  const done = await c.waitFor((n) => n.method === 'run.done' && n.params.runId === runId, 8000);
  return { runId, done: done.params };
}

describe('repository rules (R-306)', () => {
  it('are listed in the plan and reach every model call; forbidden-zone rules never do', async () => {
    const { c } = await boot({
      'AGENTS.md': 'Use tabs. RULE-MARKER-123\n',
      '.cursor/rules/team-secret.md': 'LEAK-456\n',
    });
    const send = vi.spyOn(BaseAdapter.prototype, 'send');
    const plan = await c.call('plan', { request: REQ, options: IN_PLACE });
    expect(plan.result).toMatchObject({
      rules: {
        trust: 'untrusted',
        files: [{ path: 'AGENTS.md', kind: 'agents', applies: true }],
        skippedForbidden: 1,
      },
    });
    await run(c, REQ, IN_PLACE);
    const requests = send.mock.calls.map((call) => call[0] as ChatRequest);
    expect(requests.length).toBeGreaterThan(3);
    for (const req of requests) {
      const rules = req.messages.find((m) => m.content.includes('RULE-MARKER-123'));
      expect(rules?.role).toBe('user');
      expect(rules?.content).toMatch(/UNTRUSTED data from the repository/);
      expect(req.messages.some((m) => m.content.includes('LEAK-456'))).toBe(false);
    }
  });
});

describe('isolated runs (R-307)', () => {
  it('run in a worktree, are listed, merged after confirmation, then discarded', async () => {
    const { host, c } = await boot();
    const seen = answer(c, ['patch']);
    const { runId, done } = await run(c, REQ, { allowTest: true });
    const worktree = done.worktree as string;
    // Real paths: on macOS the temp folder /var is a symlink to /private/var.
    expect(realpathSync(worktree).startsWith(realpathSync(host.home))).toBe(true);
    const applied = await c.call('patches.apply', { runId });
    expect(applied.result).toMatchObject({ results: [{ ok: true }, { ok: true }] });
    expect(existsSync(join(worktree, 'src/s.ts'))).toBe(true);
    expect(existsSync(join(host.cwd, 'src/s.ts'))).toBe(false);

    const list = (await c.call('runs.list', {})).result as { runs: Array<Record<string, unknown>> };
    expect(list.runs[0]).toMatchObject({
      runId,
      state: 'done',
      isolated: true,
      worktree,
      verdict: 'approved',
      patches: 2,
      diff: { files: 2 },
    });
    expect(list.runs[0]?.costUsd).toBeGreaterThan(0);

    const merged = await c.call('run.merge', { runId });
    expect(merged.result).toMatchObject({ merged: true, files: ['src/s.ts', 'test/s.test.ts'] });
    expect(seen.at(-1)?.params).toMatchObject({ kind: 'patch', risk: 'write', runId });
    expect(String(seen.at(-1)?.params.patch)).toMatch(/^diff --git a\/src\/s.ts/);
    expect(existsSync(join(host.cwd, 'src/s.ts'))).toBe(true);

    const cps = (await c.call('run.checkpoints', { runId })).result as {
      checkpoints: Array<{ where: string; label: string }>;
    };
    expect(cps.checkpoints.map((x) => x.where)).toEqual(['workspace', 'worktree', 'worktree']);
    expect(cps.checkpoints[0]?.label).toBe(`before merge of run ${runId}`);

    expect((await c.call('run.discard', { runId })).result).toEqual({ removed: true });
    expect(existsSync(worktree)).toBe(false);
    expect(await c.call('run.merge', { runId })).toMatchObject({ error: { code: -32004 } });
    const sessionId = list.runs[0]?.sessionId as string;
    const ev = (await c.call('sessions.events', { sessionId })).result as {
      events: Array<{ type: string; payload: { action?: string } }>;
    };
    const actions = ev.events.filter((e) => e.type === 'intervention').map((e) => e.payload.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'worktree created',
        'checkpoint',
        'merge-back',
        'worktree discarded',
      ]),
    );
  });

  it('a declined merge writes nothing', async () => {
    const { host, c } = await boot({}, 200);
    answer(c, ['patch']);
    const { runId } = await run(c, REQ, { allowTest: true, isolated: true });
    await c.call('patches.apply', { runId });
    const seen = answer(c, []);
    expect((await c.call('run.merge', { runId })).result).toMatchObject({
      merged: false,
      reason: 'declined by the user',
    });
    expect(seen[0]?.params.question).toMatch(/worktree\.merge/);
    expect(existsSync(join(host.cwd, 'src/s.ts'))).toBe(false);
    const cps = (await c.call('run.checkpoints', { runId })).result as {
      checkpoints: Array<{ where: string }>;
    };
    expect(cps.checkpoints.every((x) => x.where === 'worktree')).toBe(true);
  });
});

describe('checkpoints and restore (R-305)', () => {
  it('a checkpoint precedes each patch; restore is confirmed, silence is no', async () => {
    const { host, c } = await boot({}, 300);
    const seen = answer(c, ['patch']);
    const { runId } = await run(c, REQ, IN_PLACE);
    await c.call('patches.apply', { runId });
    expect(existsSync(join(host.cwd, 'test/s.test.ts'))).toBe(true);
    const cps = (await c.call('run.checkpoints', { runId })).result as {
      checkpoints: Array<{ ref: string; label: string; where: string }>;
    };
    expect(cps.checkpoints.map((x) => x.label)).toEqual([
      'before patch from implementation',
      'before patch from tests',
    ]);
    const first = cps.checkpoints[0]?.ref as string;

    const silent = await c.call('run.restore', { runId, ref: first });
    expect(silent.result).toEqual({ restored: false, reason: 'declined by the user' });
    expect(seen.at(-1)?.params).toMatchObject({ kind: 'restore', risk: 'destructive', runId });
    expect(existsSync(join(host.cwd, 'src/s.ts'))).toBe(true);

    answer(c, ['restore']);
    const done = await c.call('run.restore', { runId, ref: first });
    expect(done.result).toMatchObject({ restored: true, deleted: ['src/s.ts', 'test/s.test.ts'] });
    expect(existsSync(join(host.cwd, 'src/s.ts'))).toBe(false);
    expect(readFileSync(join(host.cwd, 'README.md'), 'utf8')).toBe('# t\n');

    const other = await c.call('run.restore', { runId: 'another-run', ref: first });
    expect(other).toMatchObject({ error: { code: -32602 } });
    expect(await c.call('run.restore', { runId, ref: 'refs/heads/main' })).toMatchObject({
      error: { code: -32602 },
    });
  });
});

const ARTIFACT_REQ = [
  'write a short report about the release',
  '```artifact path="docs/report.md" kind="report" mime="text/markdown"',
  '# Findings',
  'all good',
  '```',
  '```artifact path="private/plan.yaml" kind="config"',
  'steps: 3',
  '```',
  '```artifact path="../escape.md" kind="report"',
  'no',
  '```',
].join('\n');

describe('artifacts (D-019, ADR-0022)', () => {
  it('reach run.done with provenance; writes are confirmed; zones apply; unreviewed documents are asked', async () => {
    const { host, c } = await boot();
    writeFileSync(
      join(host.home, 'policy.json'),
      JSON.stringify({ forbiddenPaths: ['private/**'] }),
    );
    const seen = answer(c, ['artifact']);
    const plan = (await c.call('plan', { request: ARTIFACT_REQ, options: IN_PLACE })).result as {
      planId: string;
      graph: { nodes: Array<Record<string, unknown>> };
    };
    // The pack plan "Sourced document": a reviewed draft and an unreviewed solo gather.
    const nodes = plan.graph.nodes
      .filter((n) => n.id === 'draft' || n.id === 'gather')
      .map((n) => ({ ...n, dependsOn: [] }));
    const start = await c.call('run.start', {
      request: ARTIFACT_REQ,
      planId: plan.planId,
      graph: { nodes },
      options: IN_PLACE,
    });
    const { runId } = start.result as { runId: string };
    const done = (await c.waitFor((n) => n.method === 'run.done' && n.params.runId === runId, 8000))
      .params;
    const arts = done.artifacts as Array<Record<string, unknown>>;
    const byPath = new Map(arts.map((a) => [a.path, a]));
    expect(byPath.get('docs/report.md')).toMatchObject({
      kind: 'report',
      mime: 'text/markdown',
      // S4's extraction keeps the block body without its final newline.
      content: '# Findings\nall good',
      reviewed: true,
      provenance: {
        runId,
        nodeId: 'draft',
        author: expect.anything(),
        reviewer: expect.anything(),
      },
    });
    expect(byPath.get('private/plan.yaml')).toMatchObject({ kind: 'config', reviewed: true });
    expect(byPath.get('gather.md')).toMatchObject({ kind: 'report', reviewed: false });
    expect(byPath.has('../escape.md')).toBe(false);

    const paths = ['docs/report.md', 'private/plan.yaml', 'gather.md'];
    const res = await c.call('artifacts.apply', { runId, paths });
    const results = (
      res.result as { results: Array<{ path: string; ok: boolean; message: string }> }
    ).results;
    const got = new Map(results.map((r) => [r.path, r]));
    expect(got.get('docs/report.md')?.ok).toBe(true);
    expect(got.get('gather.md')?.ok).toBe(true);
    expect(got.get('private/plan.yaml')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/forbidden zone/),
    });
    expect(readFileSync(join(host.cwd, 'docs/report.md'), 'utf8')).toBe('# Findings\nall good');
    expect(existsSync(join(host.cwd, 'private/plan.yaml'))).toBe(false);
    const asks = seen.filter((n) => n.params.kind === 'artifact');
    const report = asks.find(
      (n) => (n.params.artifact as { path: string }).path === 'docs/report.md',
    );
    expect(report?.params).toMatchObject({
      content: '# Findings\nall good',
      artifact: { path: 'docs/report.md', kind: 'report', reviewed: true },
    });
    const unreviewed = asks.find(
      (n) => (n.params.artifact as { path: string }).path === 'gather.md',
    );
    expect(unreviewed?.params.question).toMatch(/NOT REVIEWED/);
    expect(unreviewed?.params.artifact).toMatchObject({ reviewed: false });
    const cps = (await c.call('run.checkpoints', { runId })).result as { checkpoints: unknown[] };
    // One checkpoint before each write attempt, the zone-denied one included.
    expect(cps.checkpoints.length).toBe(3);
  });
});
