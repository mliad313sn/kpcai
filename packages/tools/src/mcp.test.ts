import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalToolBus } from './bus.js';
import { createToolBus } from './create.js';
import {
  connectMcpServer,
  connectMcpServers,
  loadMcpConfig,
  mcpToolName,
  resultText,
  riskFromAnnotations,
  type McpConnection,
} from './mcp.js';
import { GradedPermissionPolicy } from './policy.js';
import { call, makeCtx, RecordingJournal, tempDir } from './test-helpers/ctx.js';

const SERVER = fileURLToPath(new URL('./test-helpers/mcp-server.mjs', import.meta.url));
const serverCfg = { command: process.execPath, args: [SERVER], env: {} };

describe('MCP helpers', () => {
  it('maps annotations to risk', () => {
    expect(riskFromAnnotations({ readOnlyHint: true })).toBe('read');
    expect(riskFromAnnotations({ readOnlyHint: false, destructiveHint: true })).toBe('destructive');
    expect(riskFromAnnotations({ destructiveHint: false })).toBe('write');
    // MCP spec default: not read-only and no destructiveHint → destructive (D-012).
    expect(riskFromAnnotations(undefined)).toBe('destructive');
    expect(riskFromAnnotations({ readOnlyHint: false })).toBe('destructive');
  });

  it('namespaces and sanitises tool names', () => {
    expect(mcpToolName('gh', 'create issue/now')).toBe('mcp.gh.create_issue_now');
    expect(mcpToolName('s', 'x'.repeat(80))).toBeUndefined();
  });

  it('flattens content blocks', () => {
    const text = resultText({
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: '', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///x', text: 'inline' } },
        { type: 'resource', resource: { uri: 'file:///y', blob: 'AA' } },
        { type: 'resource_link', uri: 'file:///z', name: 'z' },
      ],
    } as never);
    expect(text).toBe(
      'a\n[image: image/png]\ninline\n[resource: file:///y]\n[resource link: file:///z]',
    );
    expect(resultText({ content: [], structuredContent: { n: 1 } } as never)).toBe('{"n":1}');
  });

  it('loads $KPAI_HOME/mcp.json, defaulting to no servers', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      expect(await loadMcpConfig(dir)).toEqual({ servers: {} });
      await writeFile(
        path.join(dir, 'mcp.json'),
        JSON.stringify({ servers: { t: { command: 'x' } } }),
      );
      expect(await loadMcpConfig(dir)).toEqual({
        servers: { t: { command: 'x', args: [], env: {} } },
      });
      await writeFile(
        path.join(dir, 'mcp.json'),
        JSON.stringify({ servers: { 'bad name!': { command: 'x' } } }),
      );
      await expect(loadMcpConfig(dir)).rejects.toThrow();
      // A file given as KPAI_HOME: ENOTDIR on POSIX, ENOENT on Windows — same error everywhere.
      await expect(loadMcpConfig(path.join(dir, 'mcp.json'))).rejects.toThrow(/not a directory/);
      expect(await loadMcpConfig(path.join(dir, 'missing-home'))).toEqual({ servers: {} });
    } finally {
      await cleanup();
    }
  });
});

describe('MCP stdio round trip', () => {
  let conn: McpConnection;
  let bus: LocalToolBus;
  const journal = new RecordingJournal();

  beforeAll(async () => {
    conn = await connectMcpServer('test', { ...serverCfg, env: { KPAI_MCP_VISIBLE: '1' } });
    bus = new LocalToolBus({ mcp: [conn], journal });
  }, 30_000);
  afterAll(() => bus.close());

  it('exposes namespaced tools with risk from annotations', () => {
    const defs = Object.fromEntries(bus.list().map((d) => [d.name, d]));
    expect(Object.keys(defs).sort()).toEqual([
      'mcp.test.echo',
      'mcp.test.env',
      'mcp.test.fail',
      'mcp.test.note',
      'mcp.test.wipe',
    ]);
    expect(defs['mcp.test.echo']).toMatchObject({ risk: 'read', source: 'mcp:test' });
    expect(defs['mcp.test.wipe']?.risk).toBe('destructive');
    expect(defs['mcp.test.note']?.risk).toBe('write');
    expect(defs['mcp.test.echo']?.inputSchema).toMatchObject({ required: ['text'] });
  });

  it('calls a read tool without asking and journals it', async () => {
    const ctx = makeCtx('/ws');
    const r = await bus.call(call('mcp.test.echo', { text: 'hi' }), ctx);
    expect(r).toEqual({ content: 'echo: hi', isError: false });
    expect(ctx.questions).toHaveLength(0);
    expect(journal.last().payload).toMatchObject({
      tool: 'mcp.test.echo',
      source: 'mcp:test',
      decision: 'allow',
      meta: { server: 'test', tool: 'echo' },
    });
  });

  it('asks for write and destructive tools', async () => {
    const ctx = makeCtx('/ws', { answers: [true, false] });
    const note = await bus.call(call('mcp.test.note', { body: 'abc' }), ctx);
    expect(note).toEqual({ content: 'noted 3 chars\n[image: image/png]', isError: false });
    const wipe = await bus.call(call('mcp.test.wipe', { target: 'all' }), ctx);
    expect(wipe.content).toMatch(/declined/);
    expect(ctx.questions).toHaveLength(2);
  });

  it('returns server errors and bus validation errors as isError results', async () => {
    expect(await bus.call(call('mcp.test.fail', {}), makeCtx('/ws'))).toEqual({
      content: 'boom',
      isError: true,
    });
    const bad = await bus.call(call('mcp.test.echo', { text: 3 }), makeCtx('/ws'));
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/invalid input for mcp\.test\.echo: text: expected "string"/);
  });

  it('passes only configured env to the server (no inherited secrets)', async () => {
    const policy = new GradedPermissionPolicy();
    policy.trust({ sessionId: 's1', root: '/ws', risk: 'write' });
    const trusted = new LocalToolBus({ tools: conn.tools, policy });
    const visible = await trusted.call(
      call('mcp.test.env', { name: 'KPAI_MCP_VISIBLE' }),
      makeCtx('/ws'),
    );
    expect(visible.content).toBe('set');
    process.env.KPAI_TEST_API_KEY = 'leak-me-not';
    try {
      const c2 = await connectMcpServer('t2', serverCfg);
      const b2 = new LocalToolBus({ mcp: [c2], policy });
      const r = await b2.call(call('mcp.t2.env', { name: 'KPAI_TEST_API_KEY' }), makeCtx('/ws'));
      expect(r.content).toBe('unset');
      await b2.close();
    } finally {
      delete process.env.KPAI_TEST_API_KEY;
    }
  }, 30_000);
});

describe('MCP connection failures and createToolBus', () => {
  it('reports servers that fail to start, keeps the others', async () => {
    const res = await connectMcpServers(
      {
        servers: {
          good: serverCfg,
          broken: { command: process.execPath, args: ['-e', 'process.exit(1)'], env: {} },
          silent: {
            command: process.execPath,
            args: ['-e', 'setTimeout(() => {}, 5000)'],
            env: {},
          },
        },
      },
      2_000,
    );
    expect(res.connections.map((c) => c.server)).toEqual(['good']);
    expect(res.errors.map((e) => e.server).sort()).toEqual(['broken', 'silent']);
    expect(res.errors.find((e) => e.server === 'silent')?.message).toMatch(/timed out/);
    await Promise.all(res.connections.map((c) => c.close()));
  }, 30_000);

  it('builds a bus with built-ins and configured servers', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await writeFile(path.join(dir, 'mcp.json'), JSON.stringify({ servers: { t: serverCfg } }));
      const { bus, mcpErrors } = await createToolBus({ kpaiHome: dir });
      expect(mcpErrors).toEqual([]);
      const names = bus.list().map((d) => d.name);
      expect(names).toContain('fs.read');
      expect(names).toContain('git.apply');
      expect(names).toContain('shell.run');
      expect(names).toContain('mcp.t.echo');
      await bus.close();
      await writeFile(path.join(dir, 'mcp.json'), '{ not json');
      const broken = await createToolBus({ kpaiHome: dir });
      expect(broken.mcpErrors[0]?.server).toBe('mcp.json');
      expect(broken.bus.list().length).toBe(9);
      const none = await createToolBus();
      expect(none.mcpErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 30_000);
});
