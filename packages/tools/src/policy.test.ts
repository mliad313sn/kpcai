import { symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition, ToolRisk } from '@kernelpai/core';
import { describe, expect, it } from 'vitest';
import { LocalToolBus } from './bus.js';
import { diffPaths, GradedPermissionPolicy, isConfirmAware, pathsInCall } from './policy.js';
import { call, makeCtx, RecordingJournal, tempDir } from './test-helpers/ctx.js';
import { ok, type LocalTool } from './types.js';

function fakeTool(name: string, risk: ToolRisk, runs: string[]): LocalTool {
  return {
    def: { name, description: name, inputSchema: { type: 'object' }, risk, source: 'builtin' },
    run: async () => {
      runs.push(name);
      return ok(`${name} done`);
    },
  };
}

function setup(policy = new GradedPermissionPolicy()) {
  const runs: string[] = [];
  const journal = new RecordingJournal();
  const tools = (['read', 'write', 'destructive'] as const).map((r) => fakeTool(`t.${r}`, r, runs));
  return { bus: new LocalToolBus({ tools, policy, journal }), runs, journal, policy };
}

describe('permission matrix (spec §3.3)', () => {
  const cases: {
    risk: ToolRisk;
    trusted: boolean;
    answer: boolean;
    asks: boolean;
    runs: boolean;
  }[] = [];
  for (const risk of ['read', 'write', 'destructive'] as const) {
    for (const trusted of [false, true]) {
      for (const answer of [false, true]) {
        const asks = risk === 'destructive' || (risk === 'write' && !trusted);
        cases.push({ risk, trusted, answer, asks, runs: !asks || answer });
      }
    }
  }

  it.each(cases)('$risk trusted=$trusted confirm=$answer → asks=$asks runs=$runs', async (c) => {
    const { bus, runs, journal, policy } = setup();
    const ctx = makeCtx('/ws', { answers: [c.answer] });
    if (c.trusted) policy.trust({ sessionId: 's1', root: '/ws', risk: 'write' });
    const res = await bus.call(call(`t.${c.risk}`, {}), ctx);
    expect(ctx.questions.length).toBe(c.asks ? 1 : 0);
    expect(runs.length).toBe(c.runs ? 1 : 0);
    expect(res.isError).toBe(!c.runs);
    const expected = !c.asks ? 'allow' : c.answer ? 'confirmed' : 'declined';
    expect(journal.last().payload.decision).toBe(expected);
    expect(journal.last().payload.risk).toBe(c.risk);
  });

  it('confirms writes once per batch (session + node), destructive every time', async () => {
    const { bus, runs } = setup();
    const ctx = makeCtx('/ws', { answers: [true, true, true, true] });
    await bus.call(call('t.write', {}), ctx);
    await bus.call(call('t.write', {}), ctx);
    expect(ctx.questions).toHaveLength(1);
    await bus.call(call('t.destructive', {}), ctx);
    await bus.call(call('t.destructive', {}), ctx);
    expect(ctx.questions).toHaveLength(3);
    const other = makeCtx('/ws', { nodeId: 'n2', answers: [true] });
    await bus.call(call('t.write', {}), other);
    expect(other.questions).toHaveLength(1);
    expect(runs).toHaveLength(5);
  });

  it('a declined write does not open the batch', async () => {
    const { bus } = setup();
    const ctx = makeCtx('/ws', { answers: [false, true] });
    expect((await bus.call(call('t.write', {}), ctx)).content).toMatch(/declined/);
    expect((await bus.call(call('t.write', {}), ctx)).isError).toBe(false);
    expect(ctx.questions).toHaveLength(2);
  });

  it('trust is scoped to the session and root', async () => {
    const { bus, policy } = setup();
    policy.trust({ sessionId: 's1', root: '/ws', risk: 'write' });
    policy.trust({ sessionId: 's1', root: '/ws', risk: 'read' });
    const otherRoot = makeCtx('/elsewhere');
    expect((await bus.call(call('t.write', {}), otherRoot)).isError).toBe(true);
    const otherSession = makeCtx('/ws', { sessionId: 's2' });
    expect((await bus.call(call('t.write', {}), otherSession)).isError).toBe(true);
    expect(otherRoot.questions.length + otherSession.questions.length).toBe(2);
  });

  it('a confirm() that throws counts as no', async () => {
    const { bus, runs } = setup();
    const ctx = makeCtx('/ws', { confirm: () => Promise.reject(new Error('no tty')) });
    const res = await bus.call(call('t.destructive', {}), ctx);
    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(0);
  });
});

describe('per-model deny and forbidden paths', () => {
  it('denies tools per model, provider wildcard and global wildcard', async () => {
    const policy = new GradedPermissionPolicy({
      denyByModel: { 'mock/m1': ['t.read'], 'cheap/*': ['t.*'], '*': ['nothing.here'] },
    });
    const { bus, runs, journal } = setup(policy);
    const m1 = makeCtx('/ws');
    const res = await bus.call(call('t.read', {}), m1);
    expect(res).toEqual({
      content: expect.stringMatching(/denied for model mock\/m1/),
      isError: true,
    });
    expect(journal.last().payload.decision).toBe('deny');
    expect(journal.last().payload.reason).toMatch(/denied/);
    const m2 = makeCtx('/ws', { model: { provider: 'mock', model: 'm2' } });
    expect((await bus.call(call('t.read', {}), m2)).isError).toBe(false);
    const cheap = makeCtx('/ws', { model: { provider: 'cheap', model: 'x' }, answers: [true] });
    expect((await bus.call(call('t.destructive', {}), cheap)).isError).toBe(true);
    expect(cheap.questions).toHaveLength(0);
    expect(runs).toEqual(['t.read']);
  });

  it('refuses any call naming a forbidden path, even reads, before asking', async () => {
    const policy = new GradedPermissionPolicy({
      forbiddenPaths: ['.env*', 'secrets/', '**/*.pem'],
    });
    const { bus, runs } = setup(policy);
    const ctx = makeCtx('/ws', { answers: [true, true, true] });
    for (const input of [
      { path: '.env' },
      { paths: ['ok.txt', 'app/.env.local'] },
      { path: 'secrets/db.txt' },
      { patch: '--- a/certs/x.pem\n+++ b/certs/x.pem\n' },
    ]) {
      const res = await bus.call(call('t.read', input), ctx);
      expect(res.content).toMatch(/forbidden zone/);
    }
    expect(ctx.questions).toHaveLength(0);
    expect(runs).toHaveLength(0);
    expect((await bus.call(call('t.read', { path: 'src/env.ts' }), ctx)).isError).toBe(false);
  });

  // File symlinks need admin rights or developer mode on Windows.
  it.skipIf(process.platform === 'win32')(
    'catches an in-root symlink to a forbidden file',
    async () => {
      const { dir, cleanup } = await tempDir();
      try {
        await writeFile(path.join(dir, '.env'), 'SECRET=1');
        await symlink(path.join(dir, '.env'), path.join(dir, 'innocent.txt'));
        const policy = new GradedPermissionPolicy({ forbiddenPaths: ['.env'] });
        const { bus } = setup(policy);
        const res = await bus.call(call('t.read', { path: 'innocent.txt' }), makeCtx(dir));
        expect(res.content).toMatch(/forbidden zone/);
      } finally {
        await cleanup();
      }
    },
  );

  it('checks shell arguments against forbidden zones', () => {
    const policy = new GradedPermissionPolicy({ forbiddenPaths: ['.env'] });
    const def: ToolDefinition = {
      name: 'shell.run',
      description: '',
      inputSchema: {},
      risk: 'destructive',
      source: 'builtin',
    };
    const ctx = makeCtx('/ws');
    expect(policy.decide(def, call('shell.run', { command: 'cat', args: ['.env'] }), ctx)).toBe(
      'deny',
    );
    expect(policy.decide(def, call('shell.run', { command: 'cat', args: ['a'] }), ctx)).toBe(
      'confirm',
    );
  });

  it('extracts paths from inputs and diffs', () => {
    expect(pathsInCall(call('x', null))).toEqual([]);
    expect(pathsInCall(call('x', { path: 'a', other: 'b', files: ['c', 1] }))).toEqual(['a', 'c']);
    const diff = 'diff --git a/x b/y\nrename from x\n--- a/x\n+++ /dev/null\n';
    expect(diffPaths(diff)).toEqual(['x', 'y', 'x', 'x']);
    expect(isConfirmAware(new GradedPermissionPolicy())).toBe(true);
  });
});
