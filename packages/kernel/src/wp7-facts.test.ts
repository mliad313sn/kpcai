/**
 * S7 WP7-F2 (D-028): the facts of a tool confirmation in a run are those of the tool being
 * confirmed. Before, every tool question of an isolated run said `inWorktree: true` and had
 * no risk, so a `write-in-worktree` pre-answer would have covered shell commands, MCP calls
 * and repository hooks, which reach past the worktree.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolBus, ToolCall, ToolContext, ToolDefinition } from '@kernelpai/core';
import { describe, expect, it } from 'vitest';
import { Kernel } from './kernel.js';
import { toolFacts, trackedBus } from './sources.js';
import { REQ, TEST_OPTIONS, recordingHost } from './test-helpers/fixture.js';

const TOOL_REQ = `${REQ} [[tool:fs.read {"path":"README.md"}]]`;

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const def = (name: string, risk: ToolDefinition['risk'], source = 'builtin'): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  risk,
  source,
});

describe('WP7-F2: D-028 facts per confirmed tool', () => {
  it('only jailed builtin writers are in the worktree; unknown tools are destructive', () => {
    const run = { inWorktree: true, physical: false };
    expect(toolFacts(def('fs.write', 'write'), run)).toEqual({ ...run, risk: 'write' });
    expect(toolFacts(def('git.apply', 'write'), run).inWorktree).toBe(true);
    expect(toolFacts(def('shell.run', 'destructive'), run).inWorktree).toBe(false);
    expect(toolFacts(def('test.run', 'write'), run).inWorktree).toBe(false);
    expect(toolFacts(def('fs.write', 'write', 'mcp:x'), run).inWorktree).toBe(false);
    expect(toolFacts(undefined, run)).toEqual({
      inWorktree: false,
      physical: false,
      risk: 'destructive',
    });
    expect(toolFacts(def('fs.write', 'write'), { ...run, inWorktree: false }).inWorktree).toBe(
      false,
    );
  });

  it('each concurrent call sees its own tool', async () => {
    const defs = [def('fs.write', 'write'), def('shell.run', 'destructive')];
    const seen: Array<[string, string | undefined]> = [];
    let current: () => ToolDefinition | undefined = () => undefined;
    const inner: ToolBus = {
      list: () => defs,
      close: async () => undefined,
      async call(call: ToolCall, ctx: ToolContext) {
        await new Promise((r) => setTimeout(r, call.name === 'fs.write' ? 30 : 5));
        await ctx.confirm(call.name);
        return { content: 'ok', isError: false };
      },
    };
    const t = trackedBus(inner);
    current = t.current;
    const ctx = (): ToolContext => ({
      model: { provider: 'm', model: 'x' },
      root: '/',
      sessionId: 's',
      nodeId: 'n',
      confirm: async (q) => (seen.push([q, current()?.name]), true),
    });
    await Promise.all([
      t.bus.call({ id: '1', name: 'fs.write', input: {} }, ctx()),
      t.bus.call({ id: '2', name: 'shell.run', input: {} }, ctx()),
    ]);
    expect(seen.sort()).toEqual([
      ['fs.write', 'fs.write'],
      ['shell.run', 'shell.run'],
    ]);
    expect(current()).toBeUndefined();
  });

  it("an isolated run's repository hook is asked as destructive and not in the worktree", async () => {
    const h = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100', PATH: process.env.PATH ?? '' });
    h.fallback = true;
    const hook = { name: 'gate', event: 'before-tool', tools: ['fs.read'], command: 'node' };
    put(h.cwd, '.kpstudio/hooks.json', JSON.stringify({ hooks: [{ ...hook, args: ['-e', '0'] }] }));
    const k = new Kernel(h);
    const handle = await k.startRun({
      request: TOOL_REQ,
      options: { ...TEST_OPTIONS, isolated: true },
    });
    await handle.done;
    await k.close();
    const asked = h.asked.filter((q) => q.kind === 'tool' && q.question.includes('hook "gate"'));
    expect(asked.length).toBeGreaterThan(0);
    for (const q of asked) expect(q).toMatchObject({ inWorktree: false, risk: 'destructive' });
  });
});
