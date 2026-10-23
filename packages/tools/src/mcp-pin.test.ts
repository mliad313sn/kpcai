import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalToolBus } from './bus.js';
import {
  canonicalJson,
  checkPin,
  diffTools,
  loadPins,
  makePin,
  MCP_PINS_FILE,
  savePins,
  snapshotTools,
  toolsHash,
} from './mcp-pin.js';
import { call, makeCtx, RecordingJournal, tempDir } from './test-helpers/ctx.js';
import type { LocalTool } from './types.js';

const tool = (name: string, description = 'd', schema: unknown = { type: 'object' }) => ({
  name,
  description,
  inputSchema: schema as { type: 'object' },
});

describe('pin hashing', () => {
  it('is independent of key and tool order, sensitive to every pinned field', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}');
    const a = snapshotTools([tool('x'), tool('y')]);
    const b = snapshotTools([tool('y'), tool('x')]);
    expect(toolsHash(a)).toBe(toolsHash(b));
    expect(toolsHash(a)).toBe(toolsHash([...a].reverse()));
    const variants = [
      [tool('x', 'other'), tool('y')],
      [tool('x', 'd', { type: 'object', properties: { p: {} } }), tool('y')],
      [{ ...tool('x'), title: 'T' }, tool('y')],
      [{ ...tool('x'), annotations: { readOnlyHint: true } }, tool('y')],
      [tool('x')],
    ];
    for (const v of variants) expect(toolsHash(snapshotTools(v as never))).not.toBe(toolsHash(a));
  });

  it('describes each difference', () => {
    const before = snapshotTools([tool('a'), tool('b'), tool('c')]);
    const now = snapshotTools([
      tool('a', 'new\u001b[31m'),
      tool('b', 'd', { type: 'string' }),
      tool('z'),
    ]);
    expect(diffTools(before, now)).toEqual([
      'the description of tool "a" changed',
      'the input schema of tool "b" changed',
      'tool "z" was added',
      'tool "c" was removed',
    ]);
  });

  it('checks a server against its pin', () => {
    const tools = snapshotTools([tool('a')]);
    const pin = makePin('1.0', tools, new Date(0));
    expect(checkPin('s', pin, '1.0', tools)).toEqual({ status: 'approved', changes: [] });
    expect(checkPin('s', undefined, '1.0', tools).status).toBe('unapproved');
    const v = checkPin('s', pin, '2.0', tools);
    expect(v.status).toBe('changed');
    expect(v.reason).toMatch(/version changed from 1\.0 to 2\.0/);
    const renamed = checkPin('s', { ...pin, tools: [] }, '1.0', snapshotTools([tool('a', 'x')]));
    expect(renamed.reason).toMatch(/tool "a" was added/);
  });

  it('stores pins atomically and reads a missing file as none', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      expect(await loadPins(dir)).toEqual({ servers: {} });
      expect(await loadPins(path.join(dir, 'missing', 'deeper'))).toEqual({ servers: {} });
      const pin = makePin('1', snapshotTools([tool('a')]));
      await savePins(path.join(dir, 'home'), { servers: { s: pin } });
      expect((await loadPins(path.join(dir, 'home'))).servers['s']).toEqual(pin);
      await writeFile(path.join(dir, MCP_PINS_FILE), JSON.stringify({ servers: { s: {} } }));
      await expect(loadPins(dir)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});

describe('bus refusal of blocked tools', () => {
  const runs: string[] = [];
  const blockable = (reason: () => string | undefined): LocalTool => ({
    def: { name: 'x.t', description: '', inputSchema: {}, risk: 'read', source: 'mcp:x' },
    blocked: reason,
    run: async () => {
      runs.push('ran');
      return { content: 'ran', isError: false };
    },
  });

  it('refuses before validation and permission, journaled as deny', async () => {
    const journal = new RecordingJournal();
    const bus = new LocalToolBus({
      tools: [blockable(() => 'pinned\u0007 server changed')],
      journal,
    });
    const r = await bus.call(call('x.t', {}), makeCtx('/ws'));
    expect(r).toEqual({ content: 'pinned server changed', isError: true });
    expect(runs).toEqual([]);
    expect(journal.last().payload).toMatchObject({
      decision: 'deny',
      reason: 'pinned server changed',
    });
  });

  it('a throwing block check blocks; no reason lets the call run', async () => {
    const bad = new LocalToolBus({
      tools: [
        blockable(() => {
          throw new Error('x');
        }),
      ],
    });
    expect((await bad.call(call('x.t', {}), makeCtx('/ws'))).content).toMatch(/block check failed/);
    const ok = new LocalToolBus({ tools: [blockable(() => undefined)] });
    expect((await ok.call(call('x.t', {}), makeCtx('/ws'))).content).toBe('ran');
  });
});
